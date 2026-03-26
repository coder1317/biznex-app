const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
Menu.setApplicationMenu(null);
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const license                          = require('./license');
const { initAutoUpdater }              = require('./auto-updater');
const { initBackupSync }               = require('./backup-sync');
const { initSentry, captureException } = require('./sentry');

// ─── Packaged-app path fix ────────────────────────────────────────────────
// When bundled by electron-builder the source tree lives inside an asar archive
// which is read-only. We redirect mutable files (DB, logs, .env) to the OS
// user-data folder (e.g. %APPDATA%\biznex-bos on Windows, ~/.config/biznex-bos on Linux).
// In dev mode this is a no-op because process.env vars are already set by .env.
const userDataPath = app.getPath('userData');

// Load .env first so project-level settings are available
const crypto = require('crypto');
const dotenv = require('dotenv');
const envFile = app.isPackaged
    ? path.join(userDataPath, '.env')
    : path.join(__dirname, '..', '.env');
dotenv.config({ path: envFile });

// ── First-run: auto-generate required secrets if missing ─────────────────────
// On a fresh install userData/.env doesn't exist, so JWT_SECRET (and
// JWT_REFRESH_SECRET) are undefined which causes jsonwebtoken to throw
// "secretOrPrivateKey must have a value" immediately at login.
// We generate cryptographically-random secrets once and persist them in userData/.env.
if (app.isPackaged && !process.env.JWT_SECRET) {
    const jwtSecret    = crypto.randomBytes(64).toString('hex');
    const refreshSecret = crypto.randomBytes(64).toString('hex');
    process.env.JWT_SECRET         = jwtSecret;
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    // Write (or append) to the userData .env so the values survive app restarts
    const secretsBlock = `\nJWT_SECRET=${jwtSecret}\nJWT_REFRESH_SECRET=${refreshSecret}\n`;
    try {
        fs.appendFileSync(envFile, secretsBlock, 'utf8');
        console.log('[main] Generated and saved JWT secrets to', envFile);
    } catch (e) {
        console.warn('[main] Could not write JWT secrets to .env — will lose them on restart:', e.message);
    }
}

// Initialise Sentry ASAP so any startup crashes are captured.
// Safe no-op when SENTRY_DSN is not set (e.g. in dev without a DSN).
initSentry();

// In packaged mode redirect mutable files to userData (the asar bundle is read-only).
// Always force DB_PATH to userData in packaged mode — the .env file (copied to userData
// on first run or bundled) may contain a dev-relative path like ./server/biznex.db which
// does not exist at runtime and causes every DB query to fail silently.
// In dev mode .env already provides correct paths so we leave them alone.
if (app.isPackaged) {
    process.env.DB_PATH = path.join(userDataPath, 'biznex.db'); // always override
    if (!process.env.LOG_DIR) process.env.LOG_DIR = path.join(userDataPath, 'logs');
}
if (!process.env.API_BASE_URL) process.env.API_BASE_URL = 'http://localhost:3000';

// Start the embedded Express server (POS backend)
try {
    require(path.join(__dirname, '..', 'server', 'server'));
    console.log('[main] Express server module loaded');
} catch (e) {
    console.error('[main] FATAL: Express server failed to load:', e.message, e.stack);
}

// Start the embedded prototype license server (SQLite, port 4000)
// In packaged mode, store its DB in userData so it persists across updates.
if (app.isPackaged && !process.env.PROTO_DB_PATH) {
    process.env.PROTO_DB_PATH = path.join(userDataPath, 'proto-license.db');
}
try {
    require(path.join(__dirname, '..', 'proto-license-server'));
} catch (e) {
    console.error('[main] proto-license-server failed to start:', e.message);
}

// License server URL — defaults to the Biznex Portal (key creation & activation)
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'http://localhost:5000';

// ─── First-run check ─────────────────────────────────────────────────────────
function isSetupComplete() {
    const flagPath = path.join(userDataPath, 'setup_complete');
    return fs.existsSync(flagPath);
}
function markSetupComplete() {
    fs.writeFileSync(path.join(userDataPath, 'setup_complete'), '1', 'utf8');
}

// Simple POST to the local POS server
function localApiPost(endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req  = http.request({
            hostname: 'localhost', port: parseInt(process.env.PORT || '3000', 10),
            path: endpoint, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
        req.write(data); req.end();
    });
}

// Poll GET /health on the local Express server until it responds (max ~30 s).
function waitForServer(port, retries = 30, delayMs = 1000) {
    const portNum = parseInt(port, 10) || port;
    return new Promise((resolve) => {
        let attempts = 0;
        function ping() {
            const req = http.get({ hostname: 'localhost', port: portNum, path: '/health', timeout: 1000 }, (res) => {
                res.resume();
                resolve(true);
            });
            req.on('error', () => {
                if (++attempts < retries) setTimeout(ping, delayMs);
                else resolve(false);
            });
            req.on('timeout', () => { req.destroy(); });
        }
        ping();
    });
}

// ─── Setup wizard window ──────────────────────────────────────────────────────
let setupWin = null;

function createSetupWindow() {
    setupWin = new BrowserWindow({
        width:  620,
        height: 680,
        resizable: false,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-setup.js'),
        },
    });
    setupWin.loadFile(path.join(__dirname, 'setup-wizard.html'));
    return setupWin;
}

// ─── Activation window ────────────────────────────────────────────────────────
function createActivationWindow() {
    const win = new BrowserWindow({
        width: 520,
        height: 640,
        resizable: false,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-activate.js'),
        },
    });
    win.loadFile(path.join(__dirname, 'activate.html'));
    return win;
}

// ─── Main app window ──────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  const indexPath = path.join(__dirname, '..', 'client', 'index.html');
  console.log('Loading frontend from', indexPath);
  win.loadFile(indexPath).catch(err => console.error('loadFile error:', err));

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (line:${line} source:${sourceId})`);
  });
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Renderer failed to load:', errorCode, errorDescription, validatedURL);
  });

  // Initialise auto-updater after the window is ready
  win.once('ready-to-show', () => {
      initAutoUpdater(win);

      // Start backup sync — reads stored licence data for credentials
      const stored = license.loadStoredLicense(userDataPath);
      if (stored && stored.licenseKey) {
          const dbPath = process.env.DB_PATH || path.join(userDataPath, 'biznex.db');
          initBackupSync(win, userDataPath, LICENSE_SERVER_URL, dbPath, {
              licenseKey:  stored.licenseKey,
              deviceId:    license.getDeviceId(),
              accessToken: stored.accessToken,
          });
      }
  });

  return win;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
let activationWin = null;
let mainWin       = null;

// Activation screen asks to activate a license key
ipcMain.handle('license:activate', async (_event, payload) => {
    return await license.activateLicense(userDataPath, LICENSE_SERVER_URL, payload);
});

// Activation screen: check offline grace period
ipcMain.handle('license:check-offline', async () => {
    return license.checkLocalLicense(userDataPath);
});

// Activation done — close activation window, open main window or setup wizard
ipcMain.on('license:activation-done', async () => {
    if (activationWin && !activationWin.isDestroyed()) activationWin.close();
    if (!isSetupComplete()) {
        // Wait for the Express server to be ready before opening the wizard
        // so that step 3 (password change) never hits ECONNREFUSED.
        await waitForServer(process.env.PORT || 3000);
        createSetupWindow();
    } else {
        mainWin = createWindow();
    }
});

// Open external URL in system browser
ipcMain.on('license:open-external', (_event, url) => {
    shell.openExternal(url);
});

// Return app version synchronously
ipcMain.on('license:get-version', (event) => {
    event.returnValue = app.getVersion();
});

// Return stored license info to the main renderer
ipcMain.handle('license:get-info', async () => {
    const stored = license.loadStoredLicense(userDataPath);
    if (!stored) return null;
    return {
        email:      stored.email,
        plan:       stored.plan,
        planLabel:  stored.planLabel  || stored.plan,
        maxDevices: stored.maxDevices,
        licenseKey: stored.licenseKey,
        activatedAt: stored.activatedAt,
        deviceId:   stored.deviceId,
    };
});

// Deactivate this device (free the seat)
ipcMain.handle('license:deactivate', async () => {
    const result = await license.deactivateLicense(userDataPath, LICENSE_SERVER_URL);
    if (result.success) {
        console.log('[license] Device deactivated — cloud features disabled');
        // Don't force reactivation — app continues to work in local-only mode
    }
    return result;
});

// ─── Setup wizard IPC ─────────────────────────────────────────────────────────
ipcMain.handle('setup:save', async (_event, data) => {
    try {
        const port = parseInt(process.env.PORT || '3000', 10);
        console.log('[setup:save] Waiting for server on port', port);
        const ready = await waitForServer(port, 30, 1000);
        console.log('[setup:save] Server ready?', ready);
        if (!ready) {
            return { success: false, error: 'Server did not start in time. Please restart the app.' };
        }

        // Retry for up to ~30 seconds in case the server is still initialising
        let res;
        let lastError = 'unknown';
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                console.log('[setup:save] Attempt', attempt + 1);
                res = await localApiPost('/api/setup', data);
                console.log('[setup:save] Got response status', res.status);
                break;
            } catch (e) {
                lastError = e.message;
                console.error('[setup:save] Attempt', attempt + 1, 'failed:', lastError);
                await new Promise(r => setTimeout(r, 1500));
            }
        }
        if (!res) return { success: false, error: 'Could not connect to local server: ' + lastError };
        if (res.status !== 200) return { success: false, error: res.body.error || 'Setup failed' };

        markSetupComplete();
        return { success: true };
    } catch (err) {
        console.error('[setup:save] Outer error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.on('setup:done', () => {
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();
    mainWin = createWindow();
});

// ─── Backup sync IPC (always registered — backup-sync only attaches if licensed) ─
// These are registered here so the renderer never gets a hanging invoke when
// initBackupSync was skipped (no license / dev mode).
ipcMain.handle('sync:backup-now', async () => {
    // Will be overridden by initBackupSync if backup sync is active;
    // returns a no-op result if not initialised.
    return { success: false, error: 'Backup sync not initialised' };
});
ipcMain.handle('sync:get-status', async () => {
    return {};
});

// Return trial status
ipcMain.handle('license:get-trial', async () => {
    return license.checkTrial(userDataPath);
});

// Activation screen: start trial and proceed
ipcMain.on('license:use-trial', async () => {
    license.startTrial(userDataPath); // explicitly start the 14-day trial
    if (activationWin && !activationWin.isDestroyed()) activationWin.close();
    if (!isSetupComplete()) {
        await waitForServer(process.env.PORT || 3000);
        createSetupWindow();
    } else {
        mainWin = createWindow();
    }
});

// ─── System startup (boot on login) ──────────────────────────────────────────
ipcMain.handle('app:get-startup', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('app:set-startup', (_event, enable) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enable) });
    return true;
});

// ─── Startup license gate ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Dev mode: bypass the license gate UNLESS SKIP_LICENSE_CHECK=false is set.
    // On every real (packaged) install the gate always runs, ensuring the activation
    // screen appears before anything else on a fresh device.
    if (!app.isPackaged && process.env.SKIP_LICENSE_CHECK !== 'false') {
        console.log('[license] DEV MODE — SKIP_LICENSE_CHECK active, bypassing license gate');
        if (!isSetupComplete()) {
            await waitForServer(parseInt(process.env.PORT || '3000', 10));
            createSetupWindow();
        } else {
            mainWin = createWindow();
        }
        return;
    }

    // Wait for embedded POS + license servers
    await waitForServer(parseInt(process.env.PORT || '3000', 10), 30, 500);
    await waitForServer(4000, 6, 500);

    // 1. Check stored / online license
    let licenseOk = false;
    try {
        const result = await license.validateOnline(userDataPath, LICENSE_SERVER_URL);
        licenseOk = result.valid;
        console.log('[license] Online:', result.valid ? `OK (${result.plan})` : result.reason);
    } catch (err) {
        const local = license.checkLocalLicense(userDataPath);
        licenseOk = local.valid;
        console.log('[license] Offline grace:', local.valid ? 'OK' : local.reason);
    }

    if (licenseOk) {
        if (!isSetupComplete()) { createSetupWindow(); } else { mainWin = createWindow(); }
        return;
    }

    // 2. Check 14-day trial
    const trial = license.checkTrial(userDataPath);
    console.log('[trial]', trial.active ? `${trial.daysLeft} days left` : 'EXPIRED');

    if (trial.active) {
        if (!isSetupComplete()) { createSetupWindow(); } else { mainWin = createWindow(); }
        return;
    }

    // 3. Neither — show activation screen (blocking gate)
    console.log('[license] No valid license or trial — showing activation screen');
    activationWin = createActivationWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

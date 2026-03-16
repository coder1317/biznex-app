/**
 * electron-shell/backup-sync.js
 *
 * Automatically backs up the SQLite database to the cloud licensing server
 * on a configurable schedule.
 *
 * Flow:
 *  1. Find the SQLite DB file (DB_PATH env var or userData/biznex.db)
 *  2. Create a safe backup copy using sqlite3's VACUUM INTO (atomic snapshot)
 *  3. POST the file to the cloud server /api/sync/push (multipart/form-data)
 *  4. Store last-sync metadata in userData/sync_status.json
 *
 * Call `initBackupSync(mainWindow)` once the main window is ready.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const { ipcMain } = require('electron');

let _mainWindow   = null;
let _userDataPath = null;
let _syncTimer    = null;

const STATUS_FILE  = () => path.join(_userDataPath, 'sync_status.json');
const BACKUP_TMP   = () => path.join(_userDataPath, 'backup_tmp.db');

// ── IPC helpers ───────────────────────────────────────────────────────────────
function sendToRenderer(event, payload) {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
        _mainWindow.webContents.send(event, payload);
    }
}

// ── Status persistence ────────────────────────────────────────────────────────
function readStatus() {
    try { return JSON.parse(fs.readFileSync(STATUS_FILE(), 'utf8')); } catch { return {}; }
}
function writeStatus(data) {
    try { fs.writeFileSync(STATUS_FILE(), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// ── Create SQLite backup using sqlite3 CLI or file copy ───────────────────────
function createBackupFile(dbPath, destPath) {
    return new Promise((resolve, reject) => {
        // Use sqlite3 module's backup API if available, otherwise do a raw file copy.
        // A raw copy is safe when WAL mode is used (most reads won't be mid-transaction).
        try {
            // Try using the sqlite3 .backup() API
            const sqlite3 = require('sqlite3').verbose();
            const srcDb   = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    // Fall back to file copy
                    fs.copyFileSync(dbPath, destPath);
                    resolve(destPath);
                    return;
                }
                srcDb.serialize(() => {
                    // VACUUM INTO creates a clean, consistent copy
                    srcDb.run(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`, (vacErr) => {
                        srcDb.close();
                        if (vacErr) {
                            // VACUUM INTO needs SQLite 3.27+; fall back to copy
                            try { fs.copyFileSync(dbPath, destPath); resolve(destPath); }
                            catch (copyErr) { reject(copyErr); }
                        } else {
                            resolve(destPath);
                        }
                    });
                });
            });
        } catch (e) {
            // Fallback
            try { fs.copyFileSync(dbPath, destPath); resolve(destPath); }
            catch (copyErr) { reject(copyErr); }
        }
    });
}

// ── Multipart form-data upload (no external deps) ─────────────────────────────
function uploadFile(serverUrl, endpoint, filePath, headers) {
    return new Promise((resolve, reject) => {
        const boundary = '----BiznexSyncBoundary' + crypto.randomBytes(12).toString('hex');
        const fileData = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);

        const bodyParts = [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
            fileData,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ];
        const body = Buffer.concat(bodyParts);

        const url = new URL(endpoint, serverUrl);
        const opts = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers: {
                ...headers,
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            },
        };
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(opts, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('Upload timed out')));
        req.write(body);
        req.end();
    });
}

// ── Token refresh ──────────────────────────────────────────────────────────────
/**
 * Attempt to refresh an expired access token using the stored refresh token.
 * Returns the new access token string, or null on failure.
 */
function refreshAccessToken(serverUrl, refreshToken) {
    return new Promise((resolve) => {
        if (!refreshToken) return resolve(null);
        const payload = JSON.stringify({ refreshToken });
        const url = new URL('/api/auth/refresh', serverUrl);
        const opts = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        };
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(opts, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const body = JSON.parse(raw);
                    if (res.statusCode === 200 && body.accessToken) {
                        console.log('[backup-sync] Access token refreshed');
                        resolve(body.accessToken);
                    } else {
                        console.warn('[backup-sync] Token refresh failed:', body.error || res.statusCode);
                        resolve(null);
                    }
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.write(payload);
        req.end();
    });
}

// ── Core sync function ────────────────────────────────────────────────────────
async function runSync(serverUrl, dbPath, licenseKey, deviceId, licenseData) {
    let accessToken = licenseData.accessToken;
    console.log('[backup-sync] Starting backup…');
    sendToRenderer('sync:status', { syncing: true, message: 'Backup in progress…' });

    const tmpPath = BACKUP_TMP();
    let success = false;

    try {
        // 1. Create backup snapshot
        await createBackupFile(dbPath, tmpPath);

        // 2. Upload (with one automatic token refresh on 401)
        let res = await uploadFile(serverUrl, '/api/sync/push', tmpPath, {
            'Authorization':  `Bearer ${accessToken}`,
            'X-Device-Id':    deviceId,
            'X-License-Key':  licenseKey,
        });

        // If unauthorized, try refreshing the token once and retry
        if (res.status === 401 && licenseData.refreshToken) {
            const newToken = await refreshAccessToken(serverUrl, licenseData.refreshToken);
            if (newToken) {
                licenseData.accessToken = newToken; // update in-place so next call uses fresh token
                res = await uploadFile(serverUrl, '/api/sync/push', tmpPath, {
                    'Authorization':  `Bearer ${newToken}`,
                    'X-Device-Id':    deviceId,
                    'X-License-Key':  licenseKey,
                });
            }
        }

        if (res.status === 200 && res.body.success) {
            success = true;
            const status = {
                lastSyncAt:  new Date().toISOString(),
                checksum:    res.body.checksum,
                success:     true,
            };
            writeStatus(status);
            console.log('[backup-sync] ✅ Backup complete. Checksum:', res.body.checksum);
            sendToRenderer('sync:status', { syncing: false, success: true, lastSyncAt: status.lastSyncAt });
        } else {
            const msg = (res.body && res.body.error) || `HTTP ${res.status}`;
            console.warn('[backup-sync] Upload failed:', msg);
            sendToRenderer('sync:status', { syncing: false, success: false, error: msg });
            writeStatus({ lastSyncAt: new Date().toISOString(), success: false, error: msg });
        }
    } catch (err) {
        console.error('[backup-sync] Error:', err.message);
        sendToRenderer('sync:status', { syncing: false, success: false, error: err.message });
        writeStatus({ lastSyncAt: new Date().toISOString(), success: false, error: err.message });
    } finally {
        // Clean up temp file
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    }

    return success;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once after the main window is ready.
 * @param {BrowserWindow} mainWindow
 * @param {string} userDataPath
 * @param {string} serverUrl       - cloud license server URL
 * @param {string} dbPath          - path to the SQLite DB
 * @param {object} licenseData     - { licenseKey, deviceId, accessToken, refreshToken? }
 * @param {number} intervalMinutes - how often to sync (default: 60)
 */
function initBackupSync(mainWindow, userDataPath, serverUrl, dbPath, licenseData, intervalMinutes = 60) {
    _mainWindow   = mainWindow;
    _userDataPath = userDataPath;

    if (!licenseData || !licenseData.licenseKey) {
        console.log('[backup-sync] No license data — sync disabled');
        return;
    }

    const { licenseKey, deviceId } = licenseData;

    if (!fs.existsSync(dbPath)) {
        console.warn('[backup-sync] DB file not found at', dbPath, '— sync disabled');
        return;
    }

    // licenseData is passed by reference so token refreshes inside runSync persist
    const doSync = () => runSync(serverUrl, dbPath, licenseKey, deviceId, licenseData);

    // Run an initial sync after a 30-second delay (let the app settle)
    setTimeout(doSync, 30 * 1000);

    // Then on a schedule
    const intervalMs = intervalMinutes * 60 * 1000;
    _syncTimer = setInterval(doSync, intervalMs);
    console.log(`[backup-sync] Scheduled every ${intervalMinutes} min`);

    // IPC: override the fallback handlers registered in main.js with real ones
    // removeHandler first to avoid 'handler already registered' errors.
    ipcMain.removeHandler('sync:backup-now');
    ipcMain.removeHandler('sync:get-status');
    ipcMain.handle('sync:backup-now', () => doSync());
    ipcMain.handle('sync:get-status', () => readStatus());
}

function stopBackupSync() {
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
}

module.exports = { initBackupSync, stopBackupSync };

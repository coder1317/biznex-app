/**
 * electron-shell/auto-updater.js
 *
 * Wraps electron-updater.
 * Call `initAutoUpdater(mainWindow)` once the main window is ready.
 * All user-facing messaging goes through IPC → renderer toast/dialog.
 */

const { autoUpdater } = require('electron-updater');
const { ipcMain, dialog } = require('electron');

// Use console as a simple logger fallback
const log = {
    info:  (...a) => console.log('[updater]', ...a),
    warn:  (...a) => console.warn('[updater]', ...a),
    error: (...a) => console.error('[updater]', ...a),
};

let _mainWindow = null;

function sendToRenderer(channel, payload) {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
        _mainWindow.webContents.send(channel, payload);
    }
}

function initAutoUpdater(mainWindow) {
    _mainWindow = mainWindow;

    // Don't update in dev mode
    if (!require('electron').app.isPackaged) {
        log.info('Dev mode — auto-updater disabled');
        return;
    }

    autoUpdater.logger       = null;   // we handle logging ourselves
    autoUpdater.autoDownload = true;   // download in background silently
    autoUpdater.autoInstallOnAppQuit = true;

    // ── Events ──────────────────────────────────────────────────────────────
    autoUpdater.on('checking-for-update', () => {
        log.info('Checking for update…');
        sendToRenderer('update:checking', null);
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available:', info.version);
        sendToRenderer('update:available', { version: info.version, releaseNotes: info.releaseNotes });
    });

    autoUpdater.on('update-not-available', (info) => {
        log.info('No update available. Current version is latest:', info.version);
        sendToRenderer('update:not-available', { version: info.version });
    });

    autoUpdater.on('download-progress', (progress) => {
        log.info(`Download progress: ${Math.round(progress.percent)}%`);
        sendToRenderer('update:download-progress', {
            percent:          Math.round(progress.percent),
            transferred:      progress.transferred,
            total:            progress.total,
            bytesPerSecond:   progress.bytesPerSecond,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded:', info.version);
        sendToRenderer('update:downloaded', { version: info.version });

        // Show native dialog to restart and install
        dialog.showMessageBox(_mainWindow, {
            type:      'info',
            title:     'Update Ready',
            message:   `Biznex BOS v${info.version} has been downloaded.`,
            detail:    'Restart now to install the update, or it will be applied the next time you launch the app.',
            buttons:   ['Restart Now', 'Later'],
            defaultId: 0,
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
        });
    });

    autoUpdater.on('error', (err) => {
        log.error('Update error:', err.message);
        sendToRenderer('update:error', { message: err.message });
    });

    // Check immediately on startup (after a short delay so the window renders first)
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);

    // Then check every 4 hours
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}

// IPC: renderer can request a manual update check
ipcMain.handle('update:check-now', async () => {
    if (!require('electron').app.isPackaged) {
        return { message: 'Auto-updater only runs in packaged builds' };
    }
    try {
        await autoUpdater.checkForUpdates();
        return { message: 'Check initiated' };
    } catch (err) {
        return { message: err.message };
    }
});

// IPC: renderer can trigger install-and-restart
ipcMain.on('update:install-now', () => {
    autoUpdater.quitAndInstall();
});

module.exports = { initAutoUpdater };

/**
 * Electron preload script — Security + API URL + License + Update events
 *
 * Runs in the renderer's sandboxed context with Node access.
 * Uses contextBridge to safely expose ONLY what the renderer needs,
 * so nodeIntegration can remain disabled.
 */
const { contextBridge, ipcRenderer } = require('electron');

// ─── Sentry renderer SDK ──────────────────────────────────────────────────────
// Initialise in the preload so renderer errors/unhandled rejections are captured.
// The SDK tunnels events to the main process which forwards them to Sentry.
if (process.env.SENTRY_DSN) {
    try {
        const { init } = require('@sentry/electron/renderer');
        init({
            dsn: process.env.SENTRY_DSN,
            release: `biznex-bos@${process.env.npm_package_version || '1.0.0'}`,
            environment: process.env.NODE_ENV || 'production',
        });
    } catch (e) {
        console.error('[Sentry] Renderer init failed:', e.message);
    }
}

// Expose a read-only config object to the renderer (window.APP_CONFIG).
contextBridge.exposeInMainWorld('APP_CONFIG', {
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    appVersion: process.env.npm_package_version || '1.0.0',
});

// Expose minimal license info so the UI can show plan/expiry if desired
contextBridge.exposeInMainWorld('LICENSE', {
    getInfo:    () => ipcRenderer.invoke('license:get-info'),
    getTrial:   () => ipcRenderer.invoke('license:get-trial'),
    deactivate: () => ipcRenderer.invoke('license:deactivate'),
});

// Expose update API so the renderer can show update banners / trigger checks
contextBridge.exposeInMainWorld('UPDATER', {
    /** Subscribe to update events from main process */
    on: (event, callback) => {
        const validEvents = [
            'update:checking', 'update:available', 'update:not-available',
            'update:download-progress', 'update:downloaded', 'update:error',
        ];
        if (!validEvents.includes(event)) return;
        ipcRenderer.on(event, (_e, data) => callback(data));
    },
    /** Manually trigger an update check */
    checkNow: () => ipcRenderer.invoke('update:check-now'),
    /** Install the downloaded update and restart */
    installNow: () => ipcRenderer.send('update:install-now'),
});

// Expose backup sync API
contextBridge.exposeInMainWorld('SYNC', {
    /** Subscribe to sync status events { syncing, success, error, lastSyncAt } */
    on: (event, callback) => {
        if (event !== 'sync:status') return;
        ipcRenderer.on('sync:status', (_e, data) => callback(data));
    },
    /** Trigger a manual backup right now */
    backupNow: () => ipcRenderer.invoke('sync:backup-now'),
    /** Get last sync status from disk */
    getStatus: () => ipcRenderer.invoke('sync:get-status'),
});

// Open the Biznex Portal in the default browser
contextBridge.exposeInMainWorld('APP_ACTIONS', {
    openPortal: () => ipcRenderer.send('license:open-external', 'http://localhost:5000'),
});

// OS-level startup (launch on login) settings
contextBridge.exposeInMainWorld('APP_SETTINGS', {
    getStartup: ()      => ipcRenderer.invoke('app:get-startup'),
    setStartup: (enable) => ipcRenderer.invoke('app:set-startup', enable),
});

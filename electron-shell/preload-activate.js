/**
 * Preload for the activation window.
 * Exposes a minimal `licenseAPI` to the activation screen renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
    /** Attempt to activate a license key against the license server */
    activate: (payload) => ipcRenderer.invoke('license:activate', payload),

    /** Tell main process activation succeeded — open main window / setup */
    activationDone: () => ipcRenderer.send('license:activation-done'),

    /** Check if a local grace-period token still exists and is valid */
    checkOffline: () => ipcRenderer.invoke('license:check-offline'),

    /** Get trial status { active, daysLeft, trialDays, startedAt } */
    getTrial: () => ipcRenderer.invoke('license:get-trial'),

    /** Start/continue trial and proceed to app */
    useTrial: () => ipcRenderer.send('license:use-trial'),

    /** Open a URL in the system browser */
    openExternal: (url) => ipcRenderer.send('license:open-external', url),

    /** Get the app version string */
    getVersion: () => ipcRenderer.sendSync('license:get-version'),
});

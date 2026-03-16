/**
 * Preload for the first-run setup wizard window.
 * Exposes `window.setupAPI` so the wizard HTML can call main-process functions.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
    /** Save all wizard data to DB and userData */
    saveSetup: (data) => ipcRenderer.invoke('setup:save', data),
    /** Close wizard and launch the main app window */
    setupDone: () => ipcRenderer.send('setup:done'),
});

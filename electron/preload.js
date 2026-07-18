// Electron preload — exposes a safe, minimal API to the main and setup UI.
// The renderer has no direct access to Node/ipcRenderer; everything goes through window.harness.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  // Returns { anthropicKey, kimiKey, resendKey } for prefilling the fields when the setup screen opens.
  getKeys: () => ipcRenderer.invoke('keys:get'),

  // Saves the keys; the main process then restarts the server and switches the window to the main UI.
  saveKeys: (keys) => ipcRenderer.invoke('keys:save', keys),

  // Opens the setup (wizard) screen from the main UI.
  openSetup: () => ipcRenderer.send('setup:open'),
});

// Electron preload — izlaže siguran, minimalan API glavnom i setup UI-ju.
// Renderer nema pristup Node/ipcRenderer direktno; sve ide preko window.harness.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  // Vraća { anthropicKey, kimiKey } za prefill polja pri otvaranju setup ekrana.
  getKeys: () => ipcRenderer.invoke('keys:get'),

  // Čuva ključeve; main proces potom restartuje server i prebacuje prozor na glavni UI.
  saveKeys: (keys) => ipcRenderer.invoke('keys:save', keys),

  // Otvara setup (wizard) ekran iz glavnog UI-ja.
  openSetup: () => ipcRenderer.send('setup:open'),
});

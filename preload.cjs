const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronIPC', {
  send: (channel, ...args) => {
    const allowed = ['oauth-open'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, ...args);
  },
});

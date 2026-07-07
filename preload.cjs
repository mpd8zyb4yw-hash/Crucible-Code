const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronIPC', {
  send: (channel, ...args) => {
    const allowed = ['oauth-open'];
    if (allowed.includes(channel)) ipcRenderer.send(channel, ...args);
  },
  invoke: (channel, ...args) => {
    const allowed = ['pick-local-models-folder'];
    if (!allowed.includes(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
});

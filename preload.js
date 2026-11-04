const { contextBridge, ipcRenderer, webFrame } = require('electron');
contextBridge.exposeInMainWorld('cc', {
  invoke: (c, ...a) => ipcRenderer.invoke(c, ...a),
  zoom: f => webFrame.setZoomFactor(f),
  on: (c, f) => ipcRenderer.on(c, (_, d) => f(d)),
});

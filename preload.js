const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickOutputDir: () => ipcRenderer.invoke('pick-output-dir'),
  probe: (filePath) => ipcRenderer.invoke('probe', filePath),
  compress: (job) => ipcRenderer.invoke('compress', job),
  cancel: (jobId) => ipcRenderer.invoke('cancel', jobId),
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),
  thumbnail: (filePath, duration) => ipcRenderer.invoke('thumbnail', filePath, duration),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  onProgress: (callback) => {
    const handler = (_evt, data) => callback(data);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },
});

// Runs in an isolated context with Node access, and exposes only this small,
// safe surface to the actual web app (js/chat.js etc.) as window.jioDesktop.
// That's how the renderer tells it's running in the desktop shell at all —
// the same index.html on GitHub Pages simply never sees this global.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jioDesktop', {
  // relative and same-origin as the page on purpose — main.js proxies this
  // through to the actual llama-server port, so the renderer never makes a
  // cross-origin request (and never has to trust llama-server's own CORS
  // headers, which vary by version and flags).
  localBaseUrl: '/local',
  status: () => ipcRenderer.invoke('jio:local-status'),
  retry: () => ipcRenderer.invoke('jio:local-retry'),
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('jio:local-status', handler);
    return () => ipcRenderer.removeListener('jio:local-status', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('jio:open-external', url),
});

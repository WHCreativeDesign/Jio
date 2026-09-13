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
  appVersion: () => ipcRenderer.invoke('jio:app-version'),
  checkForUpdates: () => ipcRenderer.invoke('jio:check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('jio:quit-and-install'),
  onUpdateStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('jio:update-status', handler);
    return () => ipcRenderer.removeListener('jio:update-status', handler);
  },
  // A real, visible Chromium window jio drives for research mode (js/research.js).
  // Every call here resolves to the page's current { url, title, elements, text }
  // reading (see desktop/src/browser.js) unless noted otherwise.
  browser: {
    open: () => ipcRenderer.invoke('jio:browser-open'),
    close: () => ipcRenderer.invoke('jio:browser-close'),
    navigate: (url) => ipcRenderer.invoke('jio:browser-navigate', url),
    read: () => ipcRenderer.invoke('jio:browser-read'),
    screenshot: () => ipcRenderer.invoke('jio:browser-screenshot'), // -> base64 PNG
    click: (id) => ipcRenderer.invoke('jio:browser-click', id),
    type: (id, text) => ipcRenderer.invoke('jio:browser-type', id, text),
    pressEnter: (id) => ipcRenderer.invoke('jio:browser-press-enter', id),
    scroll: (dir) => ipcRenderer.invoke('jio:browser-scroll', dir),
    back: () => ipcRenderer.invoke('jio:browser-back'),
  },
});

// jio desktop shell. Loads the same web app (copied into ./web at build time,
// see scripts/copy-web.js) through a tiny local HTTP server rather than
// file://, so fetch()/CORS/crypto.subtle all behave exactly as they do on
// GitHub Pages. Cloud providers still go through the Supabase edge function
// unchanged; a bundled llama.cpp server adds a "local" provider, reached
// through this same server at /local/* (proxied through to llama-server's own
// port — see proxyToLlama below) so the renderer never makes a cross-origin
// request. No network required once the model is downloaded.
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, globalShortcut, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Browser } = require('./browser');

const isDev = !app.isPackaged;
const WEB_DIR = path.join(__dirname, '..', 'web');
const LLAMA_DIR = isDev
  ? path.join(__dirname, '..', 'resources', 'llama')
  : path.join(process.resourcesPath, 'llama');
const MODELS_DIR = path.join(app.getPath('userData'), 'models');
const LLAMA_PORT = 8790;
const STATIC_PORT = 8791;
const CAPTION_H = 36;
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');

// A handful of shell features below (tray, jump list, thumbar buttons, taskbar
// progress, native toasts, a global summon shortcut) only make sense — or only
// exist as APIs at all — on Windows, so they're gated on this rather than
// sprinkled with inline platform checks. setAppUserModelId has to run before
// any notification is shown or Windows won't credit them to jio (they'd show
// as coming from "Electron" instead, unstyled).
const IS_WINDOWS = process.platform === 'win32';
if (IS_WINDOWS) app.setAppUserModelId('org.usecloak.jio');

// Bartowski's GGUF quantizations are the de facto standard, one file per
// quant level. Swap this (and MODEL_FILE) to move to a different model or
// quant — nothing else in this file assumes a specific one.
const MODEL_FILE = 'Qwen2.5-3B-Instruct-Q4_K_M.gguf';
const MODEL_URL = 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf';

let mainWindow = null;
let llamaProc = null;
let llamaStatus = { state: 'idle', detail: '' }; // idle | downloading | starting | ready | error
let tray = null;
let isQuitting = false;

/* ---------- Windows taskbar progress ----------
   setProgressBar takes 0..1 for a determinate bar; passing a value > 1 (with
   an explicit indeterminate mode) covers the gap before a download's total
   size is known yet. null clears the bar. Both the model download below and
   the update-check further down feed through this one function. */
function setTaskbarProgress(fraction, indeterminate = false) {
  if (!IS_WINDOWS || !mainWindow) return;
  if (fraction == null) { mainWindow.setProgressBar(-1); return; }
  mainWindow.setProgressBar(indeterminate ? 2 : fraction, indeterminate ? { mode: 'indeterminate' } : undefined);
}

function setStatus(state, detail = '') {
  llamaStatus = { state, detail };
  if (mainWindow) mainWindow.webContents.send('jio:local-status', llamaStatus);
  if (state !== 'downloading') { setTaskbarProgress(null); return; }
  try {
    const { received, total } = JSON.parse(detail || '{}');
    setTaskbarProgress(total ? received / total : 0, !total);
  } catch { setTaskbarProgress(0, true); }
}

/* ---------- update check (manual button, and the silent one at launch) ---------- */
// idle | checking | available | not-available | downloading | downloaded | error
let updateStatus = { state: 'idle', detail: '' };
function setUpdateStatus(state, detail = '') {
  updateStatus = { state, detail };
  if (mainWindow) mainWindow.webContents.send('jio:update-status', updateStatus);
  if (state === 'downloading') setTaskbarProgress((Number(detail) || 0) / 100);
  else setTaskbarProgress(null);
  if (state === 'downloaded') notify('Update ready', `jio v${detail} downloaded — restart to install.`);
}
autoUpdater.on('checking-for-update', () => setUpdateStatus('checking'));
autoUpdater.on('update-available', (i) => setUpdateStatus('available', i.version));
autoUpdater.on('update-not-available', () => setUpdateStatus('not-available'));
autoUpdater.on('download-progress', (p) => setUpdateStatus('downloading', String(Math.round(p.percent))));
autoUpdater.on('update-downloaded', (i) => setUpdateStatus('downloaded', i.version));
autoUpdater.on('error', (e) => setUpdateStatus('error', e.message));

// `notify` true when the user pressed the button (a "you're up to date"
// toast makes sense); false for the silent launch-time check, which should
// stay invisible unless there's actually something to do.
/* The macOS builds are unsigned — shipping a signed, notarized one needs a
   paid Apple Developer certificate, which this project doesn't have. Squirrel
   (what electron-updater drives on macOS) refuses to apply an update whose
   signature it can't verify, so an auto-update attempt there doesn't just
   fail, it fails confusingly. Better to never pretend: report a distinct
   'manual' state that the UI turns into a link to the downloads page. */
const CAN_AUTO_UPDATE = process.platform !== 'darwin';
const RELEASES_URL = 'https://github.com/WHCreativeDesign/Jio/releases/latest';

function checkForUpdates(announce) {
  if (isDev) { setUpdateStatus(announce ? 'not-available' : 'idle'); return; }
  if (!CAN_AUTO_UPDATE) { setUpdateStatus(announce ? 'manual' : 'idle'); return; }
  return autoUpdater.checkForUpdates().catch((e) => setUpdateStatus('error', e.message));
}

/* ---------- tiny static server for the bundled web app ---------- */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
/* The page is served from 127.0.0.1:STATIC_PORT; llama-server listens on a
   different port, which makes any direct fetch() to it cross-origin. Rather
   than depend on llama-server sending the right CORS headers (version- and
   flag-dependent, and not something worth trusting sight unseen), requests
   under /local/ are proxied straight through on the SAME origin as the page —
   piped, not buffered, so token-by-token streaming still arrives live. */
function proxyToLlama(req, res) {
  const upstream = http.request(
    { host: '127.0.0.1', port: LLAMA_PORT, method: req.method, path: req.url.replace(/^\/local/, ''), headers: { ...req.headers, host: `127.0.0.1:${LLAMA_PORT}` } },
    (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); },
  );
  upstream.on('error', () => { res.writeHead(502); res.end('local model is not running'); });
  req.pipe(upstream);
}
/* Binds the first free port at or above STATIC_PORT.
   A hardcoded port is a single point of failure for *starting the app at
   all*: anything else already holding it (a stale jio that outlived its
   window, another program, a lingering socket in TIME_WAIT) made listen()
   emit EADDRINUSE. With no 'error' listener that became an uncaught
   exception in the main process — the app showed a JS error dialog and
   died, with no way back in short of ending the task by hand. So: never
   let a busy port be fatal, and never leave listen() unhandled. */
function startStaticServer(port = STATIC_PORT, attempt = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/local' || req.url.startsWith('/local/')) return proxyToLlama(req, res);
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = reqPath === '/' ? '/index.html' : reqPath;
      const full = path.normalize(path.join(WEB_DIR, rel));
      // block path traversal outside the web root
      if (!full.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < 20) {
        server.close();
        resolve(startStaticServer(port + 1, attempt + 1));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

/* ---------- model download (first run, or if missing) ---------- */
function modelPath() { return path.join(MODELS_DIR, MODEL_FILE); }

function downloadModel(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const get = (u, redirects = 0) => {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirects > 5) return reject(new Error('too many redirects'));
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`download failed: ${res.statusCode}`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          setStatus('downloading', JSON.stringify({ received, total }));
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      }).on('error', reject);
    };
    get(url);
  });
}

/* ---------- llama.cpp server process ---------- */
function llamaBinary() {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(LLAMA_DIR, exe);
}

async function ensureModel() {
  const dest = modelPath();
  if (fs.existsSync(dest)) return dest;
  setStatus('downloading', JSON.stringify({ received: 0, total: 0 }));
  await downloadModel(MODEL_URL, dest);
  return dest;
}

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`http://127.0.0.1:${LLAMA_PORT}/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('local model server did not become healthy in time'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function startLocalModel() {
  if (!fs.existsSync(llamaBinary())) {
    setStatus('error', 'llama.cpp runtime is missing from this build');
    return;
  }
  try {
    const model = await ensureModel();
    setStatus('starting');
    llamaProc = spawn(llamaBinary(), [
      '-m', model,
      '--port', String(LLAMA_PORT),
      '--host', '127.0.0.1',
      // -ngl 999: offload every layer that fits. Safe for the 3B Q4 default
      // (~2GB) on a 4GB card; a larger model swapped in here would need this
      // tuned down, or it'll fail to allocate rather than gracefully spilling.
      '-ngl', '999',
      '-c', '4096',
      '--log-disable',
    ]);
    llamaProc.stderr.on('data', (d) => { if (isDev) process.stderr.write(`[llama] ${d}`); });
    llamaProc.on('exit', (code) => {
      llamaProc = null;
      if (llamaStatus.state !== 'idle') setStatus('error', `local model server exited (code ${code})`);
    });
    await waitForHealth();
    setStatus('ready');
  } catch (e) {
    setStatus('error', e.message);
  }
}

ipcMain.handle('jio:local-status', () => llamaStatus);
ipcMain.handle('jio:local-retry', () => startLocalModel());
ipcMain.handle('jio:open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('jio:app-version', () => app.getVersion());
ipcMain.handle('jio:check-for-updates', () => checkForUpdates(true));
ipcMain.handle('jio:quit-and-install', () => autoUpdater.quitAndInstall());
ipcMain.handle('jio:open-releases', () => shell.openExternal(RELEASES_URL));

/* ---------- Windows shell integration ----------
   Tray, jump list, thumbnail toolbar, taskbar progress (above), a global
   summon shortcut, and native toasts — all things either exclusive to the
   Windows API surface (jump lists, thumbar buttons aren't a thing on macOS/
   Linux in Electron) or that only earn their keep here because that's what
   this pass is about. Every entry point is IS_WINDOWS-gated so the mac build
   behaves exactly as it did before. */
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (!IS_WINDOWS || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON_PATH });
  n.on('click', () => showWindow());
  n.show();
}

// Renderer-triggered (a chat reply finishing) — only worth surfacing if jio
// isn't the window already being looked at.
ipcMain.handle('jio:notify', (_e, { title, body } = {}) => {
  if (!IS_WINDOWS || mainWindow?.isFocused() || !Notification.isSupported()) return false;
  notify(title || 'jio', body || '');
  return true;
});

function createTray() {
  if (!IS_WINDOWS || tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip('jio');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show jio', click: showWindow },
    { label: 'New chat', click: () => { showWindow(); mainWindow?.webContents.send('jio:tray-action', 'new-chat'); } },
    { type: 'separator' },
    { label: 'Check for updates', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit jio', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// Right-click the taskbar icon (or its jump list) for quick actions without
// opening the window first — pure Windows: jump lists don't exist elsewhere.
function updateJumpList() {
  if (!IS_WINDOWS) return;
  app.setJumpList([{
    type: 'tasks',
    items: [
      { type: 'task', title: 'New chat', description: 'Start a new chat in jio', program: process.execPath, args: '--new-chat', iconPath: process.execPath, iconIndex: 0 },
      { type: 'task', title: 'Check for updates', description: 'Check for a newer version of jio', program: process.execPath, args: '--check-updates', iconPath: process.execPath, iconIndex: 0 },
    ],
  }]);
}

// Hovering the taskbar icon's live thumbnail also gets a quick-action button —
// again a Windows-only Electron API (setThumbarButtons is a no-op elsewhere).
function setupThumbar() {
  if (!IS_WINDOWS || !mainWindow) return;
  mainWindow.setThumbarButtons([{
    tooltip: 'New chat',
    icon: nativeImage.createFromPath(ICON_PATH),
    click: () => { showWindow(); mainWindow.webContents.send('jio:tray-action', 'new-chat'); },
  }]);
}

// A second launch while jio's already running arrives here instead of
// spawning a new process (see requestSingleInstanceLock below) — jump list
// clicks and thumbar/tray actions on an already-running jio both funnel
// through this same argv check.
function handleLaunchArgs(argv) {
  if (!mainWindow) return;
  if (argv.includes('--new-chat')) mainWindow.webContents.send('jio:tray-action', 'new-chat');
  if (argv.includes('--check-updates')) checkForUpdates(true);
}

// Ctrl+Shift+J summons jio from anywhere, like a spotlight — registered
// process-wide via Windows' global hotkey API, not just while focused.
function registerGlobalShortcut() {
  if (!IS_WINDOWS) return;
  globalShortcut.register('Control+Shift+J', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showWindow();
  });
}

/* ---------- research browser (real, visible, jio-driven Chromium) ---------- */
// open()/hide() attach or hide the embedded view; setBounds keeps it glued to
// wherever js/chat.js's ResizeObserver reports the research panel placeholder
// sitting, every time that panel moves or resizes.
ipcMain.handle('jio:browser-open', () => { Browser.attach(mainWindow); return Browser.open(); });
ipcMain.handle('jio:browser-hide', () => Browser.hide());
ipcMain.handle('jio:browser-set-bounds', (_e, rect) => Browser.setBounds(rect));
ipcMain.handle('jio:browser-navigate', (_e, url) => Browser.navigate(url));
ipcMain.handle('jio:browser-read', () => Browser.read());
ipcMain.handle('jio:browser-screenshot', () => Browser.screenshot());
ipcMain.handle('jio:browser-click', (_e, id) => Browser.click(id));
ipcMain.handle('jio:browser-type', (_e, id, text) => Browser.type(id, text));
ipcMain.handle('jio:browser-press-enter', (_e, id) => Browser.pressEnter(id));
ipcMain.handle('jio:browser-scroll', (_e, dir) => Browser.scroll(dir));
ipcMain.handle('jio:browser-back', () => Browser.back());

/* ---------- app lifecycle ---------- */
/* One jio at a time. Without this, launching it again while a copy is
   already running meant a second process racing for the same port and
   dying on it. Now the second launch hands focus to the window that's
   already open — which is what clicking the icon again should do anyway. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    handleLaunchArgs(argv);
  });
  start();
}

// Set once by the tray's "Quit jio" (and by any other real app.quit()) so the
// window's own 'close' handler below knows to let it actually close instead
// of hiding to the tray.
app.on('before-quit', () => { isQuitting = true; tray?.destroy(); });
app.on('will-quit', () => { if (IS_WINDOWS) globalShortcut.unregisterAll(); });

/* The two platforms hide their title bar in genuinely different ways, so this
   is a real branch rather than one config with a flag:

   Windows draws its caption bar in the *system* theme, which for most people
   is light — a white strip above a dark app. Hiding it and painting our own
   overlay in jio's sidebar color keeps the window one piece; the native
   minimise/maximise/close buttons still render, just tinted, top-RIGHT.

   macOS has no equivalent repaint problem (the traffic lights already sit on
   whatever you put behind them) and no titleBarOverlay — passing one is
   simply ignored there. 'hiddenInset' keeps the lights but drops the bar,
   and nudging them down centers them against jio's own header row. They live
   top-LEFT, which is why the page reserves its gutter on the other side
   there (see .is-mac in css/app.css). */
function windowChrome() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: (CAPTION_H - 16) / 2 },
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f1e1d', symbolColor: '#c2c0b6', height: CAPTION_H },
  };
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 560,
    // matches --bg-side, so the very first paint (before the page loads) is
    // already jio-colored rather than a white flash
    backgroundColor: '#1f1e1d',
    autoHideMenuBar: true,
    ...windowChrome(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  // Close (the X button) minimizes to the tray instead of quitting — the
  // same convention Discord/Slack/Spotify use on Windows — so the local
  // model server and any in-flight download survive being "closed". Only
  // once isQuitting is set (tray's Quit, or any real app.quit()) does the
  // window actually close.
  mainWindow.on('close', (e) => {
    if (IS_WINDOWS && tray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  setupThumbar();
  return mainWindow;
}

function start() {
app.whenReady().then(async () => {
  const { port } = await startStaticServer();
  createWindow(port);
  createTray();
  updateJumpList();
  registerGlobalShortcut();
  handleLaunchArgs(process.argv);

  /* macOS keeps the app running with every window closed (see
     window-all-closed below), so clicking the Dock icon has to be able to
     bring one back — otherwise the app is alive but unreachable. */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });

  startLocalModel();

  if (!isDev) checkForUpdates(false);
}).catch((err) => {
  // Anything that goes wrong before the window exists would otherwise
  // surface as Electron's raw "A JavaScript error occurred in the main
  // process" box and take the app down. Say what happened in plain words
  // instead, then exit deliberately.
  dialog.showErrorBox('jio could not start', `${err && err.message ? err.message : err}\n\nIf this keeps happening, close any running copy of jio and try again.`);
  app.quit();
});
}

app.on('window-all-closed', () => {
  if (llamaProc) llamaProc.kill();
  Browser.detach();
  if (process.platform !== 'darwin') app.quit();
});

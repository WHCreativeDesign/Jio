// jio desktop shell. Loads the same web app (copied into ./web at build time,
// see scripts/copy-web.js) through a tiny local HTTP server rather than
// file://, so fetch()/CORS/crypto.subtle all behave exactly as they do on
// GitHub Pages. Cloud providers still go through the Supabase edge function
// unchanged; a bundled llama.cpp server adds a "local" provider, reached
// through this same server at /local/* (proxied through to llama-server's own
// port — see proxyToLlama below) so the renderer never makes a cross-origin
// request. No network required once the model is downloaded.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;
const WEB_DIR = path.join(__dirname, '..', 'web');
const LLAMA_DIR = isDev
  ? path.join(__dirname, '..', 'resources', 'llama')
  : path.join(process.resourcesPath, 'llama');
const MODELS_DIR = path.join(app.getPath('userData'), 'models');
const LLAMA_PORT = 8790;
const STATIC_PORT = 8791;

// Bartowski's GGUF quantizations are the de facto standard, one file per
// quant level. Swap this (and MODEL_FILE) to move to a different model or
// quant — nothing else in this file assumes a specific one.
const MODEL_FILE = 'Qwen2.5-3B-Instruct-Q4_K_M.gguf';
const MODEL_URL = 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf';

let mainWindow = null;
let llamaProc = null;
let llamaStatus = { state: 'idle', detail: '' }; // idle | downloading | starting | ready | error

function setStatus(state, detail = '') {
  llamaStatus = { state, detail };
  if (mainWindow) mainWindow.webContents.send('jio:local-status', llamaStatus);
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
function startStaticServer() {
  return new Promise((resolve) => {
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
    server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server));
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

/* ---------- app lifecycle ---------- */
app.whenReady().then(async () => {
  await startStaticServer();
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 560,
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${STATIC_PORT}/`);
  startLocalModel();

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
});

app.on('window-all-closed', () => {
  if (llamaProc) llamaProc.kill();
  if (process.platform !== 'darwin') app.quit();
});

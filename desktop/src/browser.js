// The research browser: a real, visible Chromium window jio can drive, so
// research mode is watching an actual browser navigate rather than jio
// hallucinating page content. One instance, opened on demand.
//
// Two ways out a page's state comes back to the model, matched to what it can
// actually read (see js/research.js for which is used when):
//   - readPage(): a numbered list of visible interactive elements (links,
//     buttons, inputs) plus a clipped text extract — a plain-text "screen
//     reader" view any text model can act on, the same idea as the
//     accessibility-tree agents these browser-using models are trained on.
//   - screenshot(): a PNG, for vision-capable models (gemini, currently the
//     only provider whose OpenAI-compatible endpoint accepts image content).
// Both read the SAME numbering: readPage() stamps each element with a
// data-jio-id used by click()/type() below, so a vision model can point at
// what it sees on the screenshot by the number the text view also gives it.
const { BrowserWindow } = require('electron');

let win = null;

const MARK_AND_READ = `(() => {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  };
  const SEL = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], [onclick]';
  const els = [...document.querySelectorAll(SEL)].filter(isVisible).slice(0, 120);
  const lines = els.map((el, i) => {
    el.setAttribute('data-jio-id', String(i));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const label = (el.getAttribute('aria-label') || el.value || el.placeholder || el.innerText || el.textContent || '')
      .trim().replace(/\\s+/g, ' ').slice(0, 80);
    const kind = role || (tag === 'a' ? 'link' : tag === 'input' ? 'input(' + (el.type || 'text') + ')' : tag);
    return '[' + i + '] ' + kind + (label ? ' "' + label + '"' : '');
  });
  const text = (document.body?.innerText || '').trim().replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000);
  return JSON.stringify({ url: location.href, title: document.title, elements: lines, text });
})()`;

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1000, height: 800,
    title: 'jio — research browser',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.on('closed', () => { win = null; });
  return win;
}

function waitLoaded(w) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = (_e, code, desc) => { cleanup(); reject(new Error(desc || `failed to load (${code})`)); };
    const cleanup = () => {
      w.webContents.removeListener('did-finish-load', done);
      w.webContents.removeListener('did-fail-load', fail);
    };
    w.webContents.once('did-finish-load', done);
    w.webContents.once('did-fail-load', fail);
  });
}

const Browser = {
  isOpen: () => !!win && !win.isDestroyed(),
  focus() { if (Browser.isOpen()) win.focus(); },
  close() { if (Browser.isOpen()) win.close(); },

  async open() { ensure(); if (!win.webContents.getURL()) await Browser.navigate('https://www.google.com'); return true; },

  async navigate(url) {
    const w = ensure();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const p = waitLoaded(w);
    w.loadURL(url);
    await p;
    return Browser.read();
  },

  async read() {
    const w = ensure();
    const raw = await w.webContents.executeJavaScript(MARK_AND_READ, true).catch((e) => null);
    if (!raw) return { url: w.webContents.getURL(), title: w.webContents.getTitle(), elements: [], text: '(page did not respond to reading — it may still be loading, or blocks scripted access)' };
    return JSON.parse(raw);
  },

  async screenshot() {
    const w = ensure();
    const img = await w.capturePage();
    return img.resize({ width: 1000 }).toPNG().toString('base64');
  },

  async click(id) {
    const w = ensure();
    const ok = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-jio-id="${id}"]'); if (!el) return false;
        el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`, true,
    ).catch(() => false);
    if (!ok) throw new Error(`no element [${id}] on the current page — read() again, the page may have changed`);
    // a click often kicks off navigation; give it a moment either way before reading
    await new Promise((r) => setTimeout(r, 500));
    return Browser.read();
  },

  async type(id, text) {
    const w = ensure();
    const ok = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-jio-id="${id}"]'); if (!el) return false;
        el.scrollIntoView({ block: 'center' }); el.focus();
        const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)}); else el.textContent = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true; })()`, true,
    ).catch(() => false);
    if (!ok) throw new Error(`no element [${id}] on the current page — read() again, the page may have changed`);
    return Browser.read();
  },

  async pressEnter(id) {
    const w = ensure();
    await w.webContents.executeJavaScript(
      `document.querySelector('[data-jio-id="${id}"]')?.focus()`, true,
    ).catch(() => {});
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await new Promise((r) => setTimeout(r, 500));
    return Browser.read();
  },

  async scroll(dir) {
    const w = ensure();
    const dy = dir === 'up' ? -700 : 700;
    await w.webContents.executeJavaScript(`window.scrollBy(0, ${dy})`, true).catch(() => {});
    return Browser.read();
  },

  async back() {
    const w = ensure();
    if (!w.webContents.navigationHistory.canGoBack()) return Browser.read();
    const p = waitLoaded(w);
    w.webContents.navigationHistory.goBack();
    await p.catch(() => {});
    return Browser.read();
  },
};

module.exports = { Browser };

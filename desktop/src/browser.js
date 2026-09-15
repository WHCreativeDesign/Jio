// The research browser: a real Chromium view embedded directly in jio's own
// window (a WebContentsView layered over the renderer — the modern,
// non-deprecated replacement for the old BrowserView), rather than a separate
// popup window. js/chat.js reports where its research panel sits on screen
// (via ResizeObserver, see setupResearchPanel in js/chat.js) and this module
// keeps the real view's bounds glued to it, so it reads as part of the app
// rather than something floating beside it.
//
// Two ways a page's state comes back to the model (js/research.js), matched
// to what it can actually read:
//   - readPage(): a numbered list of visible interactive elements (links,
//     buttons, inputs) plus a clipped text extract — a plain-text "screen
//     reader" view any text model can act on, the same idea as the
//     accessibility-tree agents these browser-using models are trained on.
//   - screenshot(): a PNG, for vision-capable models (gemini, currently the
//     only provider whose OpenAI-compatible endpoint accepts image content).
// Both read the SAME numbering: readPage() stamps each element with a
// data-jio-id used by click()/type() below, so a vision model can point at
// what it sees on the screenshot by the number the text view also gives it.
const { WebContentsView } = require('electron');

let view = null;
let host = null; // the BrowserWindow it's currently attached to
let painted = false; // has it ever been shown with real (non-zero) bounds?

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
  if (!view) {
    view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    view.setVisible(false); // hidden until attach() gives it somewhere to sit
  }
  return view;
}

function waitLoaded(wc) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = (_e, code, desc) => { cleanup(); reject(new Error(desc || `failed to load (${code})`)); };
    const cleanup = () => { wc.removeListener('did-finish-load', done); wc.removeListener('did-fail-load', fail); };
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', fail);
  });
}

const Browser = {
  isOpen: () => !!view,

  /** Embed the view in `win`'s own content area — called every time the
      research panel opens. Idempotent: re-attaching to the same window is a
      no-op. Deliberately does NOT show the view — see setBounds for why. */
  attach(win) {
    ensure();
    if (host !== win) {
      if (host) host.contentView.removeChildView(view);
      win.contentView.addChildView(view);
      host = win;
    }
  },
  hide() { if (view) view.setVisible(false); },
  detach() { if (view && host) { host.contentView.removeChildView(view); host = null; } },

  /** x/y/width/height in the host window's content coordinates — exactly what
      a renderer-side getBoundingClientRect() on the panel placeholder gives.
      This is also what actually shows the view (attach() deliberately
      doesn't): a WebContentsView made visible while it still has its
      starting 0x0 bounds — the very first time the panel opens, before the
      renderer's ResizeObserver has reported real geometry — can get stuck
      compositing nothing on Windows even after it's resized. Only turning
      it on once real bounds are known avoids that; the extra hide/show
      blink the first time forces a fresh paint in case it already latched
      onto a blank frame from a stray earlier setVisible. */
  setBounds(rect) {
    if (!view) return;
    const b = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    if (b.width < 1 || b.height < 1) return;
    view.setBounds(b);
    if (!painted) { view.setVisible(false); view.setVisible(true); painted = true; }
    else view.setVisible(true);
  },

  async open() { ensure(); if (!view.webContents.getURL()) await Browser.navigate('https://www.google.com'); return true; },

  async navigate(url) {
    const wc = ensure().webContents;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const p = waitLoaded(wc);
    wc.loadURL(url);
    await p;
    return Browser.read();
  },

  async read() {
    const wc = ensure().webContents;
    const raw = await wc.executeJavaScript(MARK_AND_READ, true).catch(() => null);
    if (!raw) return { url: wc.getURL(), title: wc.getTitle(), elements: [], text: '(page did not respond to reading — it may still be loading, or blocks scripted access)' };
    return JSON.parse(raw);
  },

  async screenshot() {
    const v = ensure();
    const img = await v.webContents.capturePage();
    return img.resize({ width: 1000 }).toPNG().toString('base64');
  },

  async click(id) {
    const wc = ensure().webContents;
    const ok = await wc.executeJavaScript(
      `(() => { const el = document.querySelector('[data-jio-id="${id}"]'); if (!el) return false;
        el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`, true,
    ).catch(() => false);
    if (!ok) throw new Error(`no element [${id}] on the current page — read() again, the page may have changed`);
    // a click often kicks off navigation; give it a moment either way before reading
    await new Promise((r) => setTimeout(r, 500));
    return Browser.read();
  },

  async type(id, text) {
    const wc = ensure().webContents;
    const ok = await wc.executeJavaScript(
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
    const wc = ensure().webContents;
    await wc.executeJavaScript(`document.querySelector('[data-jio-id="${id}"]')?.focus()`, true).catch(() => {});
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await new Promise((r) => setTimeout(r, 500));
    return Browser.read();
  },

  async scroll(dir) {
    const wc = ensure().webContents;
    const dy = dir === 'up' ? -700 : 700;
    await wc.executeJavaScript(`window.scrollBy(0, ${dy})`, true).catch(() => {});
    return Browser.read();
  },

  async back() {
    const wc = ensure().webContents;
    if (!wc.navigationHistory.canGoBack()) return Browser.read();
    const p = waitLoaded(wc);
    wc.navigationHistory.goBack();
    await p.catch(() => {});
    return Browser.read();
  },
};

module.exports = { Browser };

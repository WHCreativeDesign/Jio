(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');

  const SYSTEM = `You are jio, a clean, geometric, playful personal agent. Lowercase name. Be concise and warm; use markdown when it helps. `;
  const CANVAS_SYSTEM = `Canvas mode is on. When the user asks for anything visual or buildable (a page, component, diagram, chart, document, game, mockup), produce ONE complete self-contained HTML document inside a single \`\`\`html fenced block, with inline CSS/JS and no external requests. Keep prose outside the block to a sentence or two.`;

  const STORE = 'jio.chats';
  const loadChats = () => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch (e) { return []; } };
  const saveChats = () => { try { localStorage.setItem(STORE, JSON.stringify(chats)); } catch (e) {} };

  let chats = loadChats();
  let current = null;
  let mascot;
  let abort = null;
  let canvasMode = false;

  /* ---------- theme ---------- */
  const theme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('jio.theme', t); } catch (e) {} };
  try { const t = localStorage.getItem('jio.theme'); if (t) theme(t); else if (matchMedia('(prefers-color-scheme: dark)').matches) theme('dark'); } catch (e) {}
  $('#theme').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  /* ---------- markdown ---------- */
  marked.setOptions({ breaks: true, gfm: true });
  function render(md) {
    const html = marked.parse(md);
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  }
  const HTML_BLOCK = /```html\s*\n([\s\S]*?)(```|$)/i;
  const extractHtml = (text) => { const m = text.match(HTML_BLOCK); return m ? m[1] : null; };
  const stripHtmlBlock = (text) => text.replace(HTML_BLOCK, '<div class="canvas-chip" data-open><span>▣</span><b>open in canvas</b></div>\n');

  /* ---------- boot ---------- */
  JioGate.init(boot);
  $('#lock').addEventListener('click', JioGate.lock);

  function boot() {
    app.hidden = false;
    mascot = new Mascot($('#thread-wrap'), $('#mascot'));
    const h = new Date().getHours();
    $('#greet-text').textContent = `${h < 5 ? 'up late' : h < 12 ? 'good morning' : h < 18 ? 'good afternoon' : 'good evening'}, weston`;

    Groq.MODELS.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; $('#model').appendChild(o); });
    try { const m = localStorage.getItem('jio.model'); if (m) $('#model').value = m; } catch (e) {}
    $('#model').addEventListener('change', () => { try { localStorage.setItem('jio.model', $('#model').value); } catch (e) {} });

    renderRecents();
    newChat();
    setupComposer();
    setupSidebar();
    setupCanvas();
    setupPool();
    $('#input').focus();
  }

  /* ---------- sidebar ---------- */
  function setupSidebar() {
    $('#collapse').addEventListener('click', () => app.classList.add('collapsed'));
    $('#expand').addEventListener('click', () => app.classList.remove('collapsed'));
    $('#new-chat').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#brand').addEventListener('click', (e) => { e.preventDefault(); showView('chat'); });
    document.querySelectorAll('.nav-item[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    if (matchMedia('(max-width: 900px)').matches) app.classList.add('collapsed');
  }
  function showView(v) {
    $('#view-chat').hidden = v !== 'chat';
    $('#view-pool').hidden = v !== 'pool';
    document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    if (matchMedia('(max-width: 900px)').matches) app.classList.add('collapsed');
    if (v === 'pool') renderPool();
  }
  function renderRecents() {
    const el = $('#recents'); el.innerHTML = '';
    if (!chats.length) { el.innerHTML = '<div class="empty" style="padding:4px 10px">no chats yet</div>'; return; }
    chats.slice().sort((a, b) => b.updated - a.updated).forEach(c => {
      const d = document.createElement('div');
      d.className = 'recent' + (current && c.id === current.id ? ' on' : ''); d.tabIndex = 0;
      d.innerHTML = `<span></span><button class="del" title="delete">×</button>`;
      d.querySelector('span').textContent = c.title || 'untitled';
      d.addEventListener('click', (e) => { if (e.target.closest('.del')) return; openChat(c.id); showView('chat'); });
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter') { openChat(c.id); showView('chat'); } });
      d.querySelector('.del').addEventListener('click', () => { chats = chats.filter(x => x.id !== c.id); saveChats(); if (current?.id === c.id) newChat(); renderRecents(); });
      el.appendChild(d);
    });
  }

  /* ---------- chats ---------- */
  function newChat() {
    current = { id: Math.random().toString(36).slice(2, 10), title: '', created: Date.now(), updated: Date.now(), messages: [] };
    $('#thread').innerHTML = '';
    $('#greeting').hidden = false;
    $('#chat-title').textContent = '';
    renderRecents();
    mascot.moveTo($('#greet-slot'), false);
  }
  function openChat(id) {
    const c = chats.find(x => x.id === id); if (!c) return;
    current = c;
    $('#thread').innerHTML = '';
    $('#greeting').hidden = c.messages.length > 0;
    $('#chat-title').textContent = c.title;
    c.messages.forEach(m => appendMsg(m.role, m.content));
    renderRecents();
    scrollBottom();
    const last = [...$('#thread').querySelectorAll('.msg.assistant .who')].pop();
    mascot.moveTo(last || $('#greet-slot'), false);
  }
  function persist() {
    current.updated = Date.now();
    if (!chats.some(c => c.id === current.id)) chats.push(current);
    saveChats(); renderRecents();
  }

  const EYE_MARK = '<svg viewBox="0 0 64 40" aria-hidden="true"><rect x="4" y="4" width="24" height="32" rx="8" fill="#fff"/><rect x="36" y="4" width="24" height="32" rx="8" fill="#fff"/></svg>';
  function appendMsg(role, content) {
    const d = document.createElement('div');
    d.className = `msg ${role}`;
    if (role === 'user') {
      d.innerHTML = `<div class="bubble"></div>`;
      d.querySelector('.bubble').textContent = content;
    } else {
      d.innerHTML = `<div class="who slot">${EYE_MARK}</div><div class="bubble"></div>`;
      setBubble(d.querySelector('.bubble'), content);
    }
    $('#thread').appendChild(d);
    return d;
  }
  function setBubble(bubble, text, streaming) {
    const html = render(stripHtmlBlock(text));
    bubble.innerHTML = html;
    bubble.classList.toggle('cursor', !!streaming);
    const chip = bubble.querySelector('[data-open]');
    if (chip) chip.addEventListener('click', () => openCanvas(extractHtml(text)));
  }
  const scrollBottom = () => { const w = $('#thread-wrap'); w.scrollTop = w.scrollHeight; };

  /* ---------- composer ---------- */
  function setupComposer() {
    const input = $('#input'), form = $('#composer'), send = $('#send');
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (abort) { abort.abort(); return; }
      const text = input.value.trim(); if (!text) return;
      input.value = ''; grow();
      ask(text);
    });
    $('#canvas-toggle').addEventListener('click', () => {
      canvasMode = !canvasMode;
      $('#canvas-toggle').setAttribute('aria-pressed', canvasMode);
      if (canvasMode) app.classList.add('canvas-open'); else app.classList.remove('canvas-open');
      mascot.react(canvasMode ? 'excited' : 'neutral', 1000);
    });
  }

  async function ask(text) {
    const key = Pool.pick();
    $('#greeting').hidden = true;
    current.messages.push({ role: 'user', content: text });
    if (!current.title) { current.title = text.slice(0, 48); $('#chat-title').textContent = current.title; }
    appendMsg('user', text);
    persist(); scrollBottom();

    const node = appendMsg('assistant', '');
    const bubble = node.querySelector('.bubble');
    mascot.moveTo(node.querySelector('.who')); mascot.think();

    if (!key) {
      bubble.innerHTML = `<p class="err">no groq keys in the pool yet.</p><p>add one on the <a href="#" data-pool>key pool</a> page — free at console.groq.com.</p>`;
      bubble.querySelector('[data-pool]').addEventListener('click', (e) => { e.preventDefault(); showView('pool'); });
      current.messages.push({ role: 'assistant', content: 'no groq keys in the pool yet. add one on the key pool page.' });
      persist(); mascot.done(false); return;
    }

    const sys = SYSTEM + (canvasMode ? CANVAS_SYSTEM : '');
    const messages = [{ role: 'system', content: sys }, ...current.messages.slice(-24)];
    abort = new AbortController();
    $('#send').classList.add('stop');
    let full = '';
    let lastCanvas = 0;
    try {
      full = await Groq.stream({
        key: key.key, model: $('#model').value, messages, signal: abort.signal,
        onToken: (_, text) => {
          setBubble(bubble, text, true);
          scrollBottom();
          if (canvasMode && Date.now() - lastCanvas > 400) { const h = extractHtml(text); if (h) { openCanvas(h, true); lastCanvas = Date.now(); } }
        },
      });
      Pool.report(key.id, true);
      setBubble(bubble, full, false);
      const h = extractHtml(full); if (h) openCanvas(h);
      mascot.done(true);
    } catch (err) {
      if (err.name === 'AbortError') { setBubble(bubble, full || '_stopped_', false); mascot.done(true); }
      else {
        Pool.report(key.id, false, err);
        bubble.innerHTML = `<p class="err">${escape(err.message)}</p><p class="empty">key ${Pool.mask(key.key)} · ${key.status === 'dead' ? 'dropped from pool' : 'will retry next turn'}</p>`;
        full = `error: ${err.message}`;
        mascot.done(false);
      }
    } finally {
      abort = null; $('#send').classList.remove('stop');
      current.messages.push({ role: 'assistant', content: full });
      persist();
      $('#input').focus();
    }
  }
  const escape = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- canvas ---------- */
  let canvasHtml = '';
  function setupCanvas() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.toggle('on', x === t));
      $('#canvas-frame').hidden = t.dataset.tab !== 'preview';
      $('#canvas-code').hidden = t.dataset.tab !== 'code';
    }));
    $('#canvas-close').addEventListener('click', () => { app.classList.remove('canvas-open'); });
    $('#canvas-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(canvasHtml); mascot.react('happy', 800); } catch (e) {} });
    $('#canvas-open').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([canvasHtml], { type: 'text/html' }));
      window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
  function openCanvas(html, partial) {
    if (html == null) return;
    canvasHtml = html;
    app.classList.add('canvas-open');
    $('#canvas-empty').hidden = true;
    $('#canvas-code').textContent = html;
    if (!partial || html.length % 7 === 0) $('#canvas-frame').srcdoc = html;
  }

  /* ---------- pool ---------- */
  function setupPool() {
    $('#donate').addEventListener('submit', (e) => {
      e.preventDefault();
      const note = $('#donate-note');
      try {
        Pool.add($('#donate-key').value, $('#donate-label').value);
        $('#donate-key').value = ''; $('#donate-label').value = '';
        note.textContent = 'added. thanks for feeding jio.'; note.className = 'note ok';
        mascot.react('love', 1600);
        renderPool();
      } catch (err) { note.textContent = err.message; note.className = 'note err'; mascot.react('confused', 1200); }
    });
  }
  function renderPool() {
    const mine = Pool.load();
    $('#mine-count').textContent = mine.length;
    const list = $('#mine'); list.innerHTML = '';
    if (!mine.length) list.innerHTML = '<div class="empty">none yet — add one on the left.</div>';
    mine.forEach(k => {
      const r = document.createElement('div'); r.className = 'key-row';
      r.innerHTML = `<span class="dot ${k.status}"></span><span class="lbl"></span><code>${Pool.mask(k.key)}</code><span class="uses">${k.uses} req</span><button class="del" title="remove">×</button>`;
      r.querySelector('.lbl').textContent = k.label;
      r.querySelector('.del').addEventListener('click', () => { Pool.remove(k.id); renderPool(); });
      list.appendChild(r);
    });

    const c = Pool.COMMUNITY;
    const total = c.reduce((a, k) => a + k.reqs, 0) + mine.reduce((a, k) => a + k.uses, 0);
    $('#stats').innerHTML = [
      [c.length + mine.length, 'keys in pool'],
      [c.filter(k => k.status === 'ok').length + mine.filter(k => k.status === 'ok').length, 'healthy'],
      [total.toLocaleString(), 'requests served'],
      ['~14k', 'free tokens/min'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
    $('#community').innerHTML = c.map(k => `<tr><td>${k.donor}</td><td><code>${k.masked}</code></td><td>${k.reqs.toLocaleString()}</td><td>${k.region}</td><td><span class="status"><span class="dot ${k.status}"></span>${k.status}</span></td></tr>`).join('');
  }
})();

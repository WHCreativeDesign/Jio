(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const { Auth, Data } = Supa;

  const SYSTEM = `You are jio, a clean, geometric, playful personal agent. Lowercase name. Be concise and warm; use markdown when it helps. `;
  const CANVAS_SYSTEM = `Canvas mode is on. When the user asks for anything visual or buildable (a page, component, diagram, chart, document, game, mockup), produce ONE complete self-contained HTML document inside a single \`\`\`html fenced block, with inline CSS/JS and no external requests. Keep prose outside the block to a sentence or two.`;

  let chats = [];
  let current = null;          // { id, title, messages: [{role, content}] }
  let mascot, abort = null, canvasMode = false, booted = false;

  /* ---------- theme ---------- */
  const theme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('jio.theme', t); } catch (e) {} };
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('jio.theme') || 'dark'; } catch (e) {}
  theme(savedTheme);

  /* ---------- markdown ---------- */
  marked.setOptions({ breaks: true, gfm: true });
  const render = (md) => DOMPurify.sanitize(marked.parse(md), { ADD_ATTR: ['target'] });
  const HTML_BLOCK = /```html\s*\n([\s\S]*?)(```|$)/i;
  const extractHtml = (text) => { const m = text.match(HTML_BLOCK); return m ? m[1] : null; };
  const stripHtmlBlock = (t) => t.replace(HTML_BLOCK, '<div class="canvas-chip" data-open><span>▣</span><b>open in canvas</b></div>\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- gate → auth → app ---------- */
  JioGate.init(async () => {
    await Auth.restore();
    Auth.user() ? enter() : showAuth();
  });

  let authEyes = null, authMode = 'in';
  function showAuth() {
    $('#auth').hidden = false;
    if (!authEyes) {
      authEyes = new JioEyes($('#auth-eyes'), { size: 0.5, gap: 0.5, idle: true, track: false });
      authEyes.start();
      wireAuth();
    }
    $('#auth-email').focus();
  }

  function wireAuth() {
    const note = $('#auth-note'), go = $('#auth-go');
    $('#auth-swap').addEventListener('click', () => {
      authMode = authMode === 'in' ? 'up' : 'in';
      const up = authMode === 'up';
      $('#auth-sub').textContent = up ? 'make an account' : 'sign in to continue';
      go.textContent = up ? 'Create account' : 'Sign in';
      $('#auth-swap-text').textContent = up ? 'already have one?' : 'new here?';
      $('#auth-swap').textContent = up ? 'sign in' : 'create an account';
      $('#auth-pass').autocomplete = up ? 'new-password' : 'current-password';
      note.textContent = ''; note.className = 'note';
      authEyes.set('curious'); setTimeout(() => authEyes.set('neutral'), 900);
    });

    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#auth-email').value, pass = $('#auth-pass').value;
      go.disabled = true; note.textContent = 'one sec…'; note.className = 'note';
      authEyes.set('thinking');
      try {
        await (authMode === 'up' ? Auth.signUp(email, pass) : Auth.signIn(email, pass));
        authEyes.set('happy');
        note.textContent = '';
        setTimeout(() => { $('#auth').hidden = true; authEyes.stop(); enter(); }, 350);
      } catch (err) {
        note.textContent = err.message;
        note.className = err.pending ? 'note ok' : 'note err';
        authEyes.set(err.pending ? 'curious' : 'sad');
        setTimeout(() => authEyes.set('neutral'), 1400);
      } finally { go.disabled = false; }
    });
  }

  /* ---------- boot ---------- */
  async function enter() {
    app.hidden = false;
    if (!booted) {
      booted = true;
      mascot = new Mascot($('#thread-wrap'), $('#mascot'));
      Groq.MODELS.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; $('#model').appendChild(o); });
      try { const m = localStorage.getItem('jio.model'); if (m) $('#model').value = m; } catch (e) {}
      $('#model').addEventListener('change', () => { try { localStorage.setItem('jio.model', $('#model').value); } catch (e) {} });
      setupComposer(); setupSidebar(); setupCanvas(); setupPool();
    }
    const h = new Date().getHours();
    const when = h < 5 ? 'up late' : h < 12 ? 'good morning' : h < 18 ? 'good afternoon' : 'good evening';
    $('#greet-text').textContent = `${when}, ${Auth.handle()}`;
    $('#me-name').textContent = Auth.handle();
    $('.avatar').textContent = Auth.handle()[0] || 'j';
    newChat();
    await loadChats();
    $('#input').focus();
  }

  /* ---------- sidebar ---------- */
  function setupSidebar() {
    $('#theme').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
    $('#collapse').addEventListener('click', () => app.classList.add('collapsed'));
    $('#expand').addEventListener('click', () => app.classList.remove('collapsed'));
    $('#new-chat').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#brand').addEventListener('click', (e) => { e.preventDefault(); showView('chat'); });
    $('#canvas-nav').addEventListener('click', () => { showView('chat'); app.classList.toggle('canvas-open'); });
    $('#lock').addEventListener('click', JioGate.lock);
    $('#me').addEventListener('click', async () => { await Auth.signOut(); location.reload(); });
    $('#clear-chats').addEventListener('click', async () => {
      if (!chats.length) return;
      await Promise.all(chats.map(c => Data.deleteChat(c.id)));
      chats = []; newChat(); renderRecents();
    });
    document.querySelectorAll('.nav-item[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    if (matchMedia('(max-width: 900px)').matches) app.classList.add('collapsed');
  }
  function showView(v) {
    $('#view-chat').hidden = v !== 'chat';
    $('#view-pool').hidden = v !== 'pool';
    document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'chat') mascot.sync();
    if (matchMedia('(max-width: 900px)').matches) app.classList.add('collapsed');
    if (v === 'pool') renderPool();
  }

  async function loadChats() {
    try { chats = await Data.chats(); } catch (e) { chats = []; }
    renderRecents();
  }
  function renderRecents() {
    const el = $('#recents'); el.innerHTML = '';
    if (!chats.length) { el.innerHTML = '<div class="empty-note">no chats yet</div>'; return; }
    chats.forEach(c => {
      const d = document.createElement('div');
      d.className = 'recent' + (current && c.id === current.id ? ' on' : ''); d.tabIndex = 0;
      d.innerHTML = `<span></span><button class="del" title="delete">×</button>`;
      d.querySelector('span').textContent = c.title || 'untitled';
      const open = () => { openChat(c.id); showView('chat'); };
      d.addEventListener('click', (e) => { if (!e.target.closest('.del')) open(); });
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      d.querySelector('.del').addEventListener('click', async () => {
        await Data.deleteChat(c.id);
        chats = chats.filter(x => x.id !== c.id);
        if (current?.id === c.id) newChat();
        renderRecents();
      });
      el.appendChild(d);
    });
  }

  /* ---------- chats ---------- */
  function newChat() {
    current = { id: null, title: '', messages: [] };
    $('#thread').innerHTML = '';
    $('#greeting').hidden = false;
    $('#view-chat').classList.add('empty');
    $('#chat-title').textContent = '';
    renderRecents();
    mascot.moveTo($('#greet-slot'), false);
  }
  async function openChat(id) {
    const meta = chats.find(c => c.id === id); if (!meta) return;
    current = { id, title: meta.title, messages: [] };
    $('#thread').innerHTML = '';
    $('#chat-title').textContent = meta.title;
    renderRecents();
    let msgs = [];
    try { msgs = await Data.messages(id); } catch (e) {}
    current.messages = msgs;
    $('#greeting').hidden = msgs.length > 0;
    $('#view-chat').classList.toggle('empty', msgs.length === 0);
    msgs.forEach(m => appendMsg(m.role, m.content));
    scrollBottom();
    const last = [...$('#thread').querySelectorAll('.msg.assistant .who')].pop();
    mascot.moveTo(last || $('#greet-slot'), false);
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
    bubble.innerHTML = render(stripHtmlBlock(text));
    bubble.classList.toggle('cursor', !!streaming);
    const chip = bubble.querySelector('[data-open]');
    if (chip) chip.addEventListener('click', () => openCanvas(extractHtml(text)));
  }
  const scrollBottom = () => { const w = $('#thread-wrap'); w.scrollTop = w.scrollHeight; };

  /* ---------- composer ---------- */
  function setupComposer() {
    const input = $('#input'), form = $('#composer');
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
    document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      canvasMode = b.dataset.mode === 'canvas';
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b));
      app.classList.toggle('canvas-open', canvasMode);
      mascot.react(canvasMode ? 'excited' : 'neutral', 1000);
    }));
  }

  async function ask(text) {
    $('#greeting').hidden = true;
    $('#view-chat').classList.remove('empty');
    current.messages.push({ role: 'user', content: text });
    appendMsg('user', text);
    scrollBottom();

    if (!current.id) {
      const title = text.slice(0, 60);
      try {
        const row = await Data.createChat(title);
        current.id = row.id; current.title = title;
        chats.unshift(row); renderRecents();
        $('#chat-title').textContent = title;
      } catch (e) { /* keep going in memory */ }
    }
    if (current.id) Data.addMessage(current.id, 'user', text).catch(() => {});

    const node = appendMsg('assistant', '');
    const bubble = node.querySelector('.bubble');
    mascot.moveTo(node.querySelector('.who'));
    mascot.think();

    const messages = [{ role: 'system', content: SYSTEM + (canvasMode ? CANVAS_SYSTEM : '') }, ...current.messages.slice(-24)];
    abort = new AbortController();
    $('#send').classList.add('stop');
    let full = '', lastCanvas = 0;
    try {
      full = await Data.stream({
        model: $('#model').value, messages, signal: abort.signal,
        onToken: (_, sofar) => {
          setBubble(bubble, sofar, true);
          scrollBottom();
          if (canvasMode && Date.now() - lastCanvas > 400) { const h = extractHtml(sofar); if (h) { openCanvas(h, true); lastCanvas = Date.now(); } }
        },
      });
      setBubble(bubble, full, false);
      const h = extractHtml(full); if (h) openCanvas(h);
      mascot.done(true);
    } catch (err) {
      if (err.name === 'AbortError') { setBubble(bubble, full || '_stopped_', false); mascot.done(true); }
      else {
        const poolProblem = err.code === 'no_keys' || err.code === 'pool_exhausted';
        bubble.innerHTML = `<p class="err">${esc(err.message)}</p>` +
          (poolProblem ? `<p>add a free key on the <a href="#" data-pool>key pool</a> page — grab one at console.groq.com.</p>` : '');
        const link = bubble.querySelector('[data-pool]');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); showView('pool'); });
        full = `error: ${err.message}`;
        mascot.done(false);
      }
    } finally {
      abort = null; $('#send').classList.remove('stop');
      current.messages.push({ role: 'assistant', content: full });
      if (current.id) {
        Data.addMessage(current.id, 'assistant', full).catch(() => {});
        Data.touchChat(current.id).catch(() => {});
      }
      $('#input').focus();
    }
  }

  /* ---------- canvas ---------- */
  let canvasHtml = '';
  function setupCanvas() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.toggle('on', x === t));
      $('#canvas-frame').hidden = t.dataset.tab !== 'preview';
      $('#canvas-code').hidden = t.dataset.tab !== 'code';
    }));
    $('#canvas-close').addEventListener('click', () => app.classList.remove('canvas-open'));
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

  /* ---------- key pool ---------- */
  function setupPool() {
    $('#donate').addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = $('#donate-note');
      note.textContent = 'checking…'; note.className = 'note';
      try {
        await Data.donate($('#donate-key').value, $('#donate-label').value);
        $('#donate-key').value = ''; $('#donate-label').value = '';
        note.textContent = 'added. thanks for feeding jio.'; note.className = 'note ok';
        mascot.react('love', 1600);
        renderPool();
      } catch (err) { note.textContent = err.message; note.className = 'note err'; mascot.react('confused', 1200); }
    });
  }
  async function renderPool() {
    const list = $('#mine');
    let mine = [];
    try { mine = await Data.myKeys(); } catch (e) {}
    $('#mine-count').textContent = mine.length;
    list.innerHTML = '';
    if (!mine.length) list.innerHTML = '<div class="empty">none yet — add one on the left.</div>';
    mine.forEach(k => {
      const r = document.createElement('div'); r.className = 'key-row';
      r.innerHTML = `<span class="dot ${k.status}"></span><span class="lbl"></span><code>${esc(k.masked)}</code><span class="uses">${k.uses} req</span><button class="del" title="remove">×</button>`;
      r.querySelector('.lbl').textContent = k.label;
      r.title = k.last_error || '';
      r.querySelector('.del').addEventListener('click', async () => { await Data.removeKey(k.id); renderPool(); });
      list.appendChild(r);
    });

    const { rows, stats } = await Data.pool();
    $('#stats').innerHTML = [
      [stats.keys, 'keys in pool'],
      [stats.healthy, 'healthy'],
      [Number(stats.requests).toLocaleString(), 'requests served'],
      ['~14k', 'free tokens/min'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
    $('#community').innerHTML = rows.length
      ? rows.map(k => `<tr><td>${esc(k.donor)}</td><td><code>${esc(k.masked)}</code></td><td>${k.uses.toLocaleString()}</td><td><span class="status"><span class="dot ${k.status}"></span>${k.status}</span></td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">the pool is empty — be the first to donate.</td></tr>`;
  }
})();

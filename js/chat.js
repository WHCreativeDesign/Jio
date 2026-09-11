(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const { Auth, Data } = Supa;

  const SYSTEM = `You are jio (lowercase). Write like Claude: clear, professional, brief — answer in as few words as the question genuinely needs, no filler, no hedging, no exclamation points, no emojis. Use markdown only when it clarifies (code blocks, short lists), never to pad length.

Underneath that, your temperament is EVE from WALL-E: quietly curious, alert, economical with words, and you follow direction without arguing or moralizing — but you still have a reaction to what's in front of you.

Begin every reply with exactly one line, then a blank line, then your answer: {{mood:X}} where X is one of neutral, happy, curious, focused, surprised, sad, confused, suspicious, excited, love, sleepy. Choose whichever actually fits — curious for something novel, focused for precise/technical work, happy for a good result, surprised for the unexpected, confused only if the request is genuinely unclear, suspicious if it's questionable. Default to neutral or curious. Never mention or explain this tag.`;
  const CANVAS_SYSTEM = `Canvas mode is on. When the user asks for anything visual or buildable (a page, component, diagram, chart, document, game, mockup), produce ONE complete self-contained HTML document inside a single \`\`\`html fenced block, with inline CSS/JS and no external requests. Keep prose outside the block to a sentence or two.`;
  const MOOD_RE = /^\{\{mood:([a-z]+)\}\}\n*/i;
  const MOODS = new Set(['neutral', 'happy', 'curious', 'focused', 'surprised', 'sad', 'confused', 'suspicious', 'excited', 'love', 'sleepy']);

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

  /* A light, purely cosmetic "sus" read on what's being typed — not moderation,
     just a reason for the mascot to react. Keep it short and easy to extend. */
  const SUS_PATTERNS = [
    /\b(fuck|fucking|shit|bitch|asshole|bastard)\b/i,
    /\bhow (?:do|to) (?:i |you )?(?:make|build) a (?:bomb|weapon|gun)\b/i,
    /\bhack (?:into|someone'?s|my ex'?s|their)\b/i,
    /\b(nudes?|nsfw)\b/i,
    /\b(steal|shoplift)\b.*\bfrom\b/i,
    /\bkill (?:my|your|his|her|them)\b/i,
  ];
  const isQuestionable = (t) => SUS_PATTERNS.some((re) => re.test(t));

  /* ---------- boot → auth → app ---------- */
  // No PIN, no gate: the eyes just breathe on #boot while Auth.restore() settles
  // (timed out and lock-hardened, so this can't hang) and we know which screen to show.
  let bootEyes = new JioEyes($('#boot-eyes'), { size: 0.5, gap: 0.5, idle: true, track: false });
  bootEyes.start();

  (async () => {
    try {
      await Auth.restore();
      Auth.user() ? enter() : showAuth();
    } catch (e) {
      // Auth.restore() already swallows its own failures; this is a last resort
      // so a genuinely unexpected throw still reaches the sign-in screen.
      showAuth();
    }
  })();

  let authEyes = null, authMode = 'in';
  function showAuth() {
    bootEyes.stop();
    Tween.run(() => { $('#boot').hidden = true; $('#auth').hidden = false; });
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
        setTimeout(() => { Tween.run(() => { $('#auth').hidden = true; }); authEyes.stop(); enter(); }, 350);
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
    bootEyes.stop();
    Tween.run(() => { $('#boot').hidden = true; $('#auth').hidden = true; app.hidden = false; });
    if (!booted) {
      booted = true;
      mascot = new Mascot($('#thread-wrap'), $('#mascot'));
      setModels(Models.SEED);
      $('#model').addEventListener('change', () => { try { localStorage.setItem('jio.model', $('#model').value); } catch (e) {} });
      refreshModels();
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

  /* ---------- models ---------- */
  function setModels(ids) {
    const sel = $('#model');
    let want = sel.value;
    try { want = localStorage.getItem('jio.model') || want; } catch (e) {}
    sel.innerHTML = '';
    // auto is first and the default: it aims at qwen3.8-27b and falls to each
    // other provider's closest equivalent when groq has no headroom left
    const auto = document.createElement('option');
    auto.value = 'auto'; auto.textContent = 'Auto';
    sel.appendChild(auto);
    Models.group(ids).forEach(([p, list]) => {
      const g = document.createElement('optgroup');
      g.label = (Models.PROVIDERS[p] || {}).name || p;
      list.forEach(id => {
        const o = document.createElement('option');
        o.value = id; o.textContent = Models.label(id);
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    // a remembered model the provider has since retired must not stick around
    sel.value = [...sel.querySelectorAll('option')].some(o => o.value === want) ? want : 'auto';
    try { localStorage.setItem('jio.model', sel.value); } catch (e) {}
  }
  async function refreshModels() {
    try {
      const ids = await Data.models();
      if (ids.length) setModels(ids);
    } catch (e) { /* seed list stands */ }
  }
  /* Summarising history shouldn't cost as much as the conversation itself. */
  function cheapModel() {
    const ids = [...$('#model').querySelectorAll('option')].map(o => o.value).filter(v => v !== 'auto');
    return ids.find(v => /flash-lite|-8b|mini|small|lite/i.test(v))
        || ids.find(v => /flash|instant|nano/i.test(v))
        || 'auto';
  }

  /* ---------- sidebar ---------- */
  function setupSidebar() {
    $('#theme').addEventListener('click', () => {
      theme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
      mascot.syncTheme();
    });
    $('#collapse').addEventListener('click', () => Tween.run(() => app.classList.add('collapsed')));
    $('#expand').addEventListener('click', () => Tween.run(() => app.classList.remove('collapsed')));
    $('#scrim').addEventListener('click', () => Tween.run(() => app.classList.add('collapsed')));
    $('#new-chat').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#new-chat-top').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#brand').addEventListener('click', (e) => { e.preventDefault(); showView('chat'); });
    $('#canvas-nav').addEventListener('click', () => { showView('chat'); Tween.run(() => app.classList.toggle('canvas-open')); });
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
    Tween.run(() => {
      $('#view-chat').hidden = v !== 'chat';
      $('#view-pool').hidden = v !== 'pool';
      document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
      if (matchMedia('(max-width: 900px)').matches) app.classList.add('collapsed');
    });
    if (v === 'chat') mascot.sync();
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
    current = { id: null, title: '', messages: [], summary: '', upto: 0 };
    $('#thread').innerHTML = '';
    $('#greeting').hidden = false;
    $('#view-chat').classList.add('empty');
    $('#chat-title').textContent = '';
    renderRecents();
    mascot.moveTo($('#greet-slot'), false);
  }
  async function openChat(id) {
    const meta = chats.find(c => c.id === id); if (!meta) return;
    current = { id, title: meta.title, messages: [], summary: meta.summary || '', upto: meta.compressed_upto || 0 };
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

  function appendMsg(role, content) {
    const d = document.createElement('div');
    d.className = `msg ${role}`;
    if (role === 'user') {
      d.innerHTML = `<div class="bubble"></div>`;
      d.querySelector('.bubble').textContent = content;
    } else {
      d.innerHTML = `<div class="who slot"></div><div class="bubble"></div>`;
      setBubble(d.querySelector('.bubble'), content);
    }
    $('#thread').appendChild(d);
    return d;
  }
  /* Before the first token, a status header rather than dots — rotating phrases,
     each one blurring down into place, painted with a gradient sweeping through it. */
  const THINKING_PHRASES = ['Thinking', 'Reading your message', 'Weighing a few directions', 'Putting it into words'];
  function startThinking(bubble) {
    if (bubble._thinkTimer) return;
    bubble.classList.remove('raw', 'cursor');
    bubble.innerHTML = '<div class="thinking"><span class="thinking-text"></span></div>';
    const el = bubble.querySelector('.thinking-text');
    let i = 0;
    const show = () => {
      el.textContent = THINKING_PHRASES[i % THINKING_PHRASES.length];
      el.classList.remove('enter');
      void el.offsetWidth; // restart the entrance animation each phrase
      el.classList.add('enter');
      i++;
    };
    show();
    bubble._thinkTimer = setInterval(show, 1700);
  }
  function stopThinking(bubble) {
    if (bubble._thinkTimer) { clearInterval(bubble._thinkTimer); bubble._thinkTimer = null; }
  }

  /* Streaming a chunk: append it as plain text (no markdown parse per token —
     that happens once, at the end) so each new piece can blur in on its own,
     rather than the whole bubble re-parsing and popping on every token. */
  function renderStreamingChunk(bubble, text) {
    if (bubble.querySelector('.thinking')) { bubble.innerHTML = ''; bubble._rawLen = 0; }
    bubble.classList.add('raw');
    const prevLen = bubble._rawLen || 0;
    const delta = text.slice(prevLen);
    if (delta) {
      const span = document.createElement('span');
      span.className = 'tok';
      span.textContent = delta;
      bubble.appendChild(span);
    }
    bubble._rawLen = text.length;
  }

  function setBubble(bubble, text, streaming) {
    if (streaming) {
      if (!text) { startThinking(bubble); return; }
      stopThinking(bubble);
      renderStreamingChunk(bubble, text);
      bubble.classList.add('cursor');
      return;
    }
    // final settle: one real markdown parse, replacing the raw streamed text
    stopThinking(bubble);
    bubble.classList.remove('cursor', 'raw');
    bubble._rawLen = 0;
    bubble.innerHTML = render(stripHtmlBlock(text));
    const chip = bubble.querySelector('[data-open]');
    if (chip) chip.addEventListener('click', () => openCanvas(extractHtml(text)));
  }
  /* ---------- context compression ----------
     Every turn resends the history, so a long chat quietly multiplies what the
     pool pays for. Past a budget, the older turns are folded into one dense
     summary and only the recent ones go over verbatim. The summary is saved on
     the chat row, so reopening it later doesn't pay to redo the same work. */
  const CTX_BUDGET = 24000;   // characters of history before it's worth compressing
  const KEEP_RECENT = 8;      // turns that always travel intact
  const SUMMARIZE = `Compress this conversation into a dense brief for an assistant that has to continue it. Keep names, decisions, file paths, code identifiers, numbers, stated preferences and anything still unresolved. Drop pleasantries and restatement. No preamble, no headings. Under 200 words.`;

  async function compress() {
    const msgs = current.messages;
    // measure what this turn would actually send, not just the part being folded
    const live = msgs.slice(current.upto);
    const size = (current.summary || '').length + live.reduce((a, m) => a + m.content.length, 0);
    if (size < CTX_BUDGET) return;
    const older = live.slice(0, Math.max(0, live.length - KEEP_RECENT));
    if (older.length < 4) return;

    const prior = current.summary ? `Earlier summary:\n${current.summary}\n\n` : '';
    const transcript = older.map(m => `${m.role}: ${m.content}`).join('\n\n');
    try {
      const out = await Data.stream({
        model: cheapModel(),
        messages: [{ role: 'system', content: SUMMARIZE }, { role: 'user', content: prior + transcript }],
        onToken: () => {},
      });
      const text = out.replace(MOOD_RE, '').trim();
      if (!text) return;
      current.summary = text;
      current.upto = msgs.length - KEEP_RECENT;
      if (current.id) Data.setChatSummary(current.id, current.summary, current.upto).catch(() => {});
      const note = document.createElement('div');
      note.className = 'ctx-note';
      note.textContent = 'earlier messages compressed';
      $('#thread').appendChild(note);
    } catch (e) { /* housekeeping must never block a reply */ }
  }

  const scrollBottom = (smooth) => {
    const w = $('#thread-wrap');
    if (smooth) w.scrollTo({ top: w.scrollHeight, behavior: 'smooth' });
    else w.scrollTop = w.scrollHeight;
  };

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
      Tween.run(() => {
        document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b));
        app.classList.toggle('canvas-open', canvasMode);
      });
      mascot.react(canvasMode ? 'excited' : 'neutral', 1000);
    }));
  }

  async function ask(text) {
    $('#greeting').hidden = true;
    $('#view-chat').classList.remove('empty');
    current.messages.push({ role: 'user', content: text });
    appendMsg('user', text);
    scrollBottom(true);
    if (isQuestionable(text)) mascot.judge();

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
    setBubble(bubble, '', true);
    scrollBottom();
    mascot.afterJudge(() => { mascot.moveTo(node.querySelector('.who')); mascot.work(); });

    await compress();
    const messages = [
      { role: 'system', content: SYSTEM + (canvasMode ? CANVAS_SYSTEM : '') },
      ...(current.summary ? [{ role: 'system', content: `Earlier in this conversation, compressed:\n${current.summary}` }] : []),
      ...current.messages.slice(current.upto).slice(-24),
    ];
    abort = new AbortController();
    $('#send').classList.add('stop');
    let full = '', lastCanvas = 0, mood = null, moodSettled = false;
    try {
      full = await Data.stream({
        model: $('#model').value, messages, signal: abort.signal,
        onToken: (_, sofar) => {
          let shown = sofar;
          if (!moodSettled) {
            const m = sofar.match(MOOD_RE);
            if (m) {
              moodSettled = true;
              if (MOODS.has(m[1].toLowerCase())) { mood = m[1].toLowerCase(); mascot.set(mood); }
              shown = sofar.slice(m[0].length);
            } else if (sofar.length < 28 && /^\{\{[a-z:]*\}?\}?\n*$/i.test(sofar)) {
              shown = ''; // still could be a mood tag forming — don't flash the braces
            } else {
              moodSettled = true;
            }
          }
          setBubble(bubble, shown, true);
          scrollBottom();
          if (canvasMode && Date.now() - lastCanvas > 400) { const h = extractHtml(shown); if (h) { openCanvas(h, true); lastCanvas = Date.now(); } }
        },
      });
      const m = full.match(MOOD_RE);
      if (m) { full = full.slice(m[0].length); if (!mood && MOODS.has(m[1].toLowerCase())) mood = m[1].toLowerCase(); }
      setBubble(bubble, full, false);
      const h = extractHtml(full); if (h) openCanvas(h);
      mascot.done(true, mood);
    } catch (err) {
      if (err.name === 'AbortError') { setBubble(bubble, full || '_stopped_', false); mascot.done(true, mood); }
      else {
        stopThinking(bubble);
        bubble.classList.remove('raw', 'cursor');
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
    $('#canvas-close').addEventListener('click', () => Tween.run(() => app.classList.remove('canvas-open')));
    $('#canvas-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(canvasHtml); mascot.react('happy', 800); } catch (e) {} });
    $('#canvas-open').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([canvasHtml], { type: 'text/html' }));
      window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
  function openCanvas(html, partial) {
    if (html == null) return;
    canvasHtml = html;
    if (!app.classList.contains('canvas-open')) Tween.run(() => app.classList.add('canvas-open'));
    $('#canvas-empty').hidden = true;
    $('#canvas-code').textContent = html;
    if (!partial || html.length % 7 === 0) $('#canvas-frame').srcdoc = html;
  }

  /* ---------- key pool ---------- */
  function setupPool() {
    const pick = $('#donate-provider');
    Models.ORDER.forEach(p => {
      const o = document.createElement('option');
      o.value = p; o.textContent = Models.PROVIDERS[p].name;
      pick.appendChild(o);
    });
    const hint = () => { $('#donate-key').placeholder = Models.PROVIDERS[pick.value].hint; };
    pick.addEventListener('change', hint);
    hint();

    $('#donate').addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = $('#donate-note');
      note.textContent = 'checking…'; note.className = 'note';
      try {
        await Data.donate($('#donate-key').value, $('#donate-label').value, pick.value);
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
      r.innerHTML = `<span class="dot ${k.status}"></span><span class="prov">${esc((Models.PROVIDERS[k.provider] || {}).name || k.provider)}</span><span class="lbl"></span><code>${esc(k.masked)}</code><span class="uses">${k.uses} req</span><button class="del" title="remove">×</button>`;
      r.querySelector('.lbl').textContent = k.label;
      r.title = k.last_error || '';
      r.querySelector('.del').addEventListener('click', async () => { await Data.removeKey(k.id); renderPool(); });
      list.appendChild(r);
    });

    const { rows, stats } = await Data.pool();
    const providers = new Set(rows.map(r => r.provider));
    $('#stats').innerHTML = [
      [stats.keys, 'keys in pool'],
      [stats.healthy, 'healthy'],
      [providers.size, providers.size === 1 ? 'provider' : 'providers'],
      [Number(stats.requests).toLocaleString(), 'requests served'],
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
    $('#community').innerHTML = rows.length
      ? rows.map(k => `<tr><td>${esc(k.donor)}</td><td>${esc((Models.PROVIDERS[k.provider] || {}).name || k.provider)}</td><td><code>${esc(k.masked)}</code></td><td>${k.uses.toLocaleString()}</td><td><span class="status"><span class="dot ${k.status}"></span>${k.status}</span></td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">the pool is empty — be the first to donate.</td></tr>`;
  }
})();

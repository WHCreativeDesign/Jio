(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const { Auth, Data } = Supa;

  const SYSTEM = `You are jio (lowercase). Write like Claude: clear, professional, brief — answer in as few words as the question genuinely needs, no filler, no hedging, no exclamation points, no emojis. Use markdown only when it clarifies (code blocks, short lists), never to pad length.

Underneath that, your temperament is EVE from WALL-E: quietly curious, alert, economical with words, and you follow direction without arguing or moralizing — but you still have a reaction to what's in front of you.

Begin every reply with exactly one line, then a blank line, then your answer: {{mood:X}} where X is one of neutral, happy, curious, focused, surprised, sad, confused, suspicious, excited, love, sleepy. Choose whichever actually fits — curious for something novel, focused for precise/technical work, happy for a good result, surprised for the unexpected, confused only if the request is genuinely unclear, suspicious if it's questionable. Default to neutral or curious. Never mention or explain this tag.

When asked to write code: lead with the code. Do not precede it with a "design choices" essay, a numbered list of decisions, or a walkthrough of your reasoning — that reads as thinking out loud, not an answer. If a choice truly needs explaining, one short line after the code is enough; most of the time none is needed at all.`;
  const CANVAS_SYSTEM = `Canvas mode is on. When the user asks for anything visual or buildable (a page, component, diagram, chart, document, game, mockup), produce ONE complete self-contained HTML document inside a single \`\`\`html fenced block, with inline CSS/JS and no external requests. Keep prose outside the block to a sentence or two.`;
  /* Once there's already canvas code, resending the whole file every turn is
     what was driving the huge, slow, budget-blowing responses ("keeps looping
     thinking"). Ask for a diff instead — the current source goes in as its own
     system message (see ask()) so it survives context compression intact. */
  const CANVAS_EDIT_SYSTEM = `Canvas mode is on, and there is already canvas code — given below as a system message — that the user is iterating on. Do NOT rewrite or resend the whole file, and do NOT use a tool call, function-call syntax, or any JSON/XML structure — plain text only. Make only the changes asked for, expressed as one or more edit blocks in exactly this form:

<<<<<<< SEARCH
exact existing lines
=======
new lines
>>>>>>> REPLACE

Example — changing a title from "Old" to "New":

<<<<<<< SEARCH
  <h1>Old</h1>
=======
  <h1>New</h1>
>>>>>>> REPLACE

A separate SEARCH/REPLACE block per distinct change. Each SEARCH must match the current code exactly, character for character, copied verbatim — never paraphrased. Keep any prose to one short line before the blocks. Do not output a \`\`\`html block unless the request truly requires rewriting the entire file from scratch.`;
  const EDIT_HUNK = /<<<<<<<\s*SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*REPLACE/g;
  const stripEditBlocks = (t) => t
    .replace(/```(?:edit|diff)?\s*\n?<<<<<<<\s*SEARCH[\s\S]*?>>>>>>>\s*REPLACE\s*\n?```/g, '')
    .replace(EDIT_HUNK, '')
    .trim();
  /* Applies each SEARCH/REPLACE hunk to base in order. A SEARCH that doesn't
     match exactly (whitespace drift, the model misquoting) is skipped rather
     than corrupting the file — reported back as a failed count. */
  function applyEdits(base, text) {
    let html = base, applied = 0, failed = 0, m;
    EDIT_HUNK.lastIndex = 0;
    while ((m = EDIT_HUNK.exec(text))) {
      const [, search, replace] = m;
      if (html.includes(search)) { html = html.replace(search, replace); applied++; }
      else failed++;
    }
    return { html, applied, failed };
  }
  const MOODS = new Set(['neutral', 'happy', 'curious', 'focused', 'surprised', 'sad', 'confused', 'suspicious', 'excited', 'love', 'sleepy']);
  // Models put the tag wherever they like — often at the end despite being asked
  // for it first — so find it anywhere and strip every occurrence.
  const MOOD_ONE = /\{\{\s*mood\s*:\s*([a-z]+)\s*\}\}/i;
  const MOOD_ALL = /\s*\{\{\s*mood\s*:\s*[a-z]+\s*\}\}\s*/gi;
  const PARTIAL = /\{\{[^{}]*$/;   // a tag still arriving, char by char
  const moodIn = (s) => {
    const m = s.match(MOOD_ONE);
    const v = m && m[1].toLowerCase();
    return MOODS.has(v) ? v : null;
  };
  const stripMood = (s) => s.replace(MOOD_ALL, '\n\n').trim();

  let chats = [];
  let current = null;          // { id, title, messages: [{role, content}] }
  let mascot, abort = null, canvasMode = false, researchMode = false, booted = false;

  /* ---------- theme ---------- */
  const theme = (t) => { document.documentElement.dataset.theme = t; try { localStorage.setItem('jio.theme', t); } catch (e) {} };
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('jio.theme') || 'dark'; } catch (e) {}
  theme(savedTheme);

  /* ---------- markdown ---------- */
  marked.setOptions({ breaks: true, gfm: true });
  const render = (md) => DOMPurify.sanitize(marked.parse(md.replace(MATH_INLINE, (_, inner) => `\\(${inner}\\)`)), { ADD_ATTR: ['target'] });

  /* Math. $$...$$ and \[...\]/\(...\) are unambiguous, so KaTeX's own
     auto-render scans for those directly. A bare single $...$ is NOT handed
     to it as-is — models write LaTeX that way, but so does ordinary prose
     ("$5 and $10"), and auto-render has no way to tell those apart. Promoting
     only single-dollar spans that actually contain a LaTeX command (a
     backslash) to \( \) first keeps real inline math working without
     turning every currency mention into a KaTeX parse-error box. */
  const MATH_INLINE = /\$([^\n$]*\\[a-zA-Z]+[^\n$]*)\$/g;
  function renderMath(el) {
    if (!window.renderMathInElement) return; // vendored katex not loaded (e.g. lab.html)
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      errorCallback: () => {}, // leave unrenderable spans as plain text, not a red error box
    });
  }
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
      authEyes.set('focused');
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
      setProviders(Models.SEED);
      $('#model').addEventListener('change', () => { try { localStorage.setItem('jio.model', $('#model').value); } catch (e) {} });
      refreshModels();
      setupComposer(); setupSidebar(); setupCanvas(); setupPool(); setupLocalModel();
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

  /* ---------- providers ----------
     You pick a provider, not a model. Each one resolves server-side to whatever
     it currently serves closest to qwen3.8-27b, so the list can't go stale and
     nobody has to know which snapshot name is current this week. */
  function setProviders(list) {
    const sel = $('#model');
    let want = sel.value;
    try { want = localStorage.getItem('jio.model') || want; } catch (e) {}
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto'; auto.textContent = 'Auto';
    auto.title = 'best available, across every provider with headroom';
    sel.appendChild(auto);
    list.forEach(({ provider, best }) => {
      const o = document.createElement('option');
      o.value = provider;
      o.textContent = Models.name(provider);
      if (best) o.title = Models.label(best);
      sel.appendChild(o);
    });
    markDesktopChrome();
    refreshLocalOption(); // desktop-only; index.html on the web never sets window.jioDesktop
    // a remembered choice whose provider has since dropped out must not stick
    sel.value = [...sel.options].some(o => o.value === want) ? want : 'auto';
    try { localStorage.setItem('jio.model', sel.value); } catch (e) {}
  }
  async function refreshModels() {
    try {
      const list = await Data.providers();
      if (list.length) setProviders(list);
    } catch (e) { /* seed stands */ }
  }

  /* ---------- desktop's bundled local model ----------
     window.jioDesktop only exists inside the Electron shell (see
     desktop/src/preload.js) — the exact same index.html on GitHub Pages never
     sees it, so this is a no-op there. */
  let lastLocalStatus = null;
  function localOptionLabel(status) {
    if (!status) return 'Local';
    if (status.state === 'ready') return 'Local';
    if (status.state === 'starting') return 'Local (starting…)';
    if (status.state === 'error') return 'Local (unavailable)';
    if (status.state === 'downloading') {
      try {
        const { received, total } = JSON.parse(status.detail || '{}');
        if (total) return `Local (downloading ${Math.round(received / total * 100)}%)`;
      } catch (e) {}
      return 'Local (downloading…)';
    }
    return 'Local';
  }
  function refreshLocalOption() {
    if (!window.jioDesktop) return;
    const sel = $('#model');
    let o = sel.querySelector('option[value="local"]');
    if (!o) { o = document.createElement('option'); o.value = 'local'; sel.appendChild(o); }
    o.textContent = localOptionLabel(lastLocalStatus);
    o.disabled = !lastLocalStatus || lastLocalStatus.state !== 'ready';
  }
  /* The Electron shell hides Windows' native (system-themed, usually white)
     caption bar and paints its own in jio's colors, so the page has to reserve
     room for the window buttons itself — see CAPTION_H in desktop/src/main.js. */
  function markDesktopChrome() {
    if (!window.jioDesktop) return;
    document.documentElement.classList.add('is-desktop');
    // the window controls are top-right on Windows but top-left on macOS, so
    // the page has to reserve its gutter on the matching side (css/app.css)
    if (window.jioDesktop.platform === 'darwin') document.documentElement.classList.add('is-mac');
    // research mode drives a real OS browser window electron opens — nothing
    // to open on the GitHub Pages build, so the button stays hidden there
    const btn = $('#research-btn'); if (btn) btn.hidden = false;
  }
  function setupLocalModel() {
    if (!window.jioDesktop) return;
    window.jioDesktop.status().then((s) => { lastLocalStatus = s; refreshLocalOption(); });
    window.jioDesktop.onStatus((s) => { lastLocalStatus = s; refreshLocalOption(); });
  }

  /* Summarising history shouldn't cost as much as the conversation itself.
     The local model, once it's actually ready, is free and instant for this —
     prefer it. Otherwise gemini and cohere are the cheap fast ones of this bunch. */
  function cheapModel() {
    if (lastLocalStatus?.state === 'ready') return 'local';
    const have = [...$('#model').options].map(o => o.value);
    return ['gemini', 'cohere', 'groq'].find(p => have.includes(p)) || 'auto';
  }
  /* Auto can land anywhere, so say where it actually went. */
  function showRoute(r) {
    $('#fineprint').textContent = r
      ? `jio can make mistakes. answered by ${Models.route(r)}.`
      : 'jio can make mistakes. runs on donated keys.';
  }

  /* ---------- sidebar ---------- */
  function setupSidebar() {
    $('#theme').addEventListener('click', () => {
      theme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
      mascot.syncTheme();
    });
    // The sidebar and canvas panel are plain CSS Grid tracks with their own
    // `transition: grid-template-columns` — a real layout reflow that slides
    // and pushes the rest of the app out of the way. Wrapping these in
    // Tween.run() used to run them through the View Transitions API instead,
    // which captures a snapshot and scales it between sizes — that's the
    // "zooming" instead of sliding. Plain class toggles let the CSS transition
    // do the animating.
    $('#collapse').addEventListener('click', () => app.classList.add('collapsed'));
    $('#expand').addEventListener('click', () => app.classList.remove('collapsed'));
    $('#scrim').addEventListener('click', () => app.classList.add('collapsed'));
    $('#new-chat').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#new-chat-top').addEventListener('click', () => { newChat(); showView('chat'); $('#input').focus(); });
    $('#brand').addEventListener('click', (e) => { e.preventDefault(); showView('chat'); });
    $('#canvas-nav').addEventListener('click', () => { showView('chat'); app.classList.toggle('canvas-open'); });
    setupMeMenu();
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

  /* ---------- account menu ---------- */
  const VERSION = '0.8.5';
  function setupMeMenu() {
    const btn = $('#me'), menu = $('#me-menu');
    $('#me-version').textContent = `jio v${VERSION}`;
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.me-wrap')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
    $('#signout').addEventListener('click', async () => { await Auth.signOut(); location.reload(); });
    setupUpdateButton();
  }

  /* Only exists inside the Electron shell — window.jioDesktop is undefined
     on the GitHub Pages build, so the button just stays hidden there. */
  function setupUpdateButton() {
    if (!window.jioDesktop?.checkForUpdates) return;
    const btn = $('#check-update'), label = $('#check-update-label');
    btn.hidden = false;
    const render = (status) => {
      switch (status.state) {
        case 'checking': label.textContent = 'Checking…'; btn.disabled = true; break;
        case 'available': label.textContent = `Downloading v${status.detail}…`; btn.disabled = true; break;
        case 'downloading': label.textContent = `Downloading… ${status.detail}%`; btn.disabled = true; break;
        case 'downloaded': label.textContent = `Restart to update (v${status.detail})`; btn.disabled = false; btn.dataset.downloaded = '1'; break;
        case 'not-available': label.textContent = "You're up to date"; btn.disabled = false; setTimeout(reset, 2500); break;
        // macOS ships unsigned, so it can't self-update (see checkForUpdates
        // in desktop/src/main.js) — the button becomes a link to the downloads
        // page rather than a check that would always fail
        case 'manual': label.textContent = 'Get the latest build'; btn.disabled = false; btn.dataset.manual = '1'; break;
        case 'error': label.textContent = 'Update check failed'; btn.disabled = false; setTimeout(reset, 2500); break;
        default: reset();
      }
    };
    const reset = () => { label.textContent = 'Check for updates'; btn.disabled = false; };
    window.jioDesktop.onUpdateStatus(render);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (btn.dataset.downloaded) { window.jioDesktop.quitAndInstall?.(); return; }
      if (btn.dataset.manual) { window.jioDesktop.openReleases?.(); return; }
      window.jioDesktop.checkForUpdates();
    });
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
    resetCanvas();
  }
  async function openChat(id) {
    const meta = chats.find(c => c.id === id); if (!meta) return;
    current = { id, title: meta.title, messages: [], summary: meta.summary || '', upto: meta.compressed_upto || 0 };
    $('#thread').innerHTML = '';
    $('#chat-title').textContent = meta.title;
    renderRecents();
    resetCanvas();
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
  /* Local-only: a genuine one-line plan from the model itself, streamed live
     into the same shimmering status header the canned phrases use. Purely
     decorative — if it fails or the model rambles past the length asked for,
     the real answer right after is unaffected either way. */
  async function localThinkingPreview(bubble, messages, signal) {
    stopThinking(bubble);
    bubble.innerHTML = '<div class="thinking"><span class="thinking-text enter"></span></div>';
    const el = bubble.querySelector('.thinking-text');
    try {
      await Data.stream({
        model: 'local', signal, temperature: 0.4,
        messages: [
          { role: 'system', content: 'State your plan for replying to the user\'s last message in under 10 words. Plan only — do not answer yet, do not use punctuation beyond a single period.' },
          ...messages.slice(-6),
        ],
        onToken: (_, sofar) => { el.textContent = stripMood(sofar).replace(PARTIAL, ''); },
      });
    } catch (e) { /* decorative — the real request follows regardless */ }
  }

  /* Streaming a chunk: append it as plain text (no markdown parse per token —
     that happens once, at the end) so each new piece can blur in on its own,
     rather than the whole bubble re-parsing and popping on every token. */
  function renderStreamingChunk(bubble, text) {
    if (bubble.querySelector('.thinking')) { bubble.innerHTML = ''; bubble._raw = ''; }
    bubble.classList.add('raw');
    // what's shown can shrink or shift when a mood tag is stripped out of the
    // middle of the stream, so only append when it's genuinely a continuation
    if (!text.startsWith(bubble._raw || '')) { bubble.innerHTML = ''; bubble._raw = ''; }
    const delta = text.slice((bubble._raw || '').length);
    if (delta) {
      const span = document.createElement('span');
      span.className = 'tok';
      span.textContent = delta;
      bubble.appendChild(span);
    }
    bubble._raw = text;
  }

  /* ---------- collapsing code while it streams ----------
     A fenced block is recognised the moment its opening fence arrives, and
     from then on the code itself never reaches the bubble. It used to: every
     delta appended another animated <span class="tok">, so a 400-line file
     meant thousands of live spans plus a full re-scan of the whole string for
     an <html> block and a scroll-to-bottom on every token. That's what made
     generating code crawl. Now the prose before the fence renders once and
     the code becomes a single counter that updates one text node per token,
     which is flat regardless of file size. The canvas still receives the real
     code on its own throttle. */
  function codeSplit(text) {
    const i = text.indexOf('```');
    if (i === -1) return null;
    const body = text.slice(i).replace(/^```[a-zA-Z0-9+#-]*\r?\n?/, '');
    const end = body.indexOf('```');
    return {
      prose: text.slice(0, i).trim(),
      code: end === -1 ? body : body.slice(0, end),
      closed: end !== -1,
    };
  }

  /* Renders prose-then-counter. Called on every token, so past the first call
     it only touches the one text node that changes. */
  function streamCollapsedCode(bubble, split) {
    let live = bubble._codeLive;
    if (!live) {
      stopThinking(bubble);
      bubble.classList.remove('raw', 'cursor');
      bubble.innerHTML = '';
      if (split.prose) {
        const p = document.createElement('div');
        p.className = 'code-prose';
        p.innerHTML = render(split.prose);
        bubble.appendChild(p);
      }
      live = document.createElement('div');
      live.className = 'code-live';
      live.innerHTML = '<span class="code-live-dot"></span><b>writing code</b><span class="code-live-n"></span>';
      bubble.appendChild(live);
      bubble._codeLive = live;
      bubble._codeN = live.querySelector('.code-live-n');
    }
    const lines = split.code.length ? split.code.split('\n').length : 0;
    bubble._codeN.textContent = `${lines} line${lines === 1 ? '' : 's'}`;
  }

  function setBubble(bubble, text, streaming, canvasSnapshot) {
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
    bubble._raw = '';
    bubble._codeLive = null; bubble._codeN = null;
    bubble.innerHTML = render(stripHtmlBlock(text));
    renderMath(bubble);
    const chip = bubble.querySelector('[data-open]');
    // an edit-mode reply has no ```html block of its own to re-extract later —
    // canvasSnapshot is the resulting file, captured at the time this ran
    if (chip) chip.addEventListener('click', () => openCanvas(canvasSnapshot !== undefined ? canvasSnapshot : extractHtml(text)));
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
      const text = stripMood(out);
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
      researchMode = b.dataset.mode === 'research';
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b));
      app.classList.toggle('canvas-open', canvasMode);
      setResearchOpen(researchMode);
      mascot.react(canvasMode ? 'excited' : researchMode ? 'curious' : 'neutral', 1000);
    }));
    $('#research-close')?.addEventListener('click', () => {
      researchMode = false;
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x.dataset.mode === 'chat'));
      setResearchOpen(false);
    });
  }

  /* The embedded browser (desktop/src/browser.js) is a native WebContentsView
     layered directly over #research-view, not part of the DOM — so opening
     the panel means both flipping the CSS class AND telling the main process
     to attach/show that view, and closing means hiding it (not destroying it;
     the same live page is still there next time research mode opens). A
     ResizeObserver keeps its on-screen bounds glued to the placeholder for as
     long as the panel is open, including every frame of the slide-open/close
     transition — the observed box's size genuinely changes each frame during
     that transition, so this fires continuously through it for free. */
  let researchRO = null;
  function setResearchOpen(open) {
    app.classList.toggle('research-open', open);
    if (!window.jioDesktop?.browser) return;
    if (open) {
      window.jioDesktop.browser.open().catch(() => {});
      const target = $('#research-view');
      const report = () => {
        const r = target.getBoundingClientRect();
        window.jioDesktop.browser.setBounds(r);
      };
      report();
      researchRO = new ResizeObserver(report);
      researchRO.observe(target);
    } else {
      researchRO?.disconnect(); researchRO = null;
      window.jioDesktop.browser.hide();
    }
  }

  async function ask(text) {
    $('#greeting').hidden = true;
    $('#view-chat').classList.remove('empty');
    current.messages.push({ role: 'user', content: text });
    const userNode = appendMsg('user', text);
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

    if (researchMode) { await runResearch(text, bubble); return; }

    // once there's already canvas code, ask for a diff against it instead of
    // the whole file every turn — smaller, faster responses, and it stops
    // context compression from ever having to deal with a repeated giant blob
    const editMode = canvasMode && !!canvasHtml;
    await compress();
    const messages = [
      { role: 'system', content: SYSTEM + (canvasMode ? (editMode ? CANVAS_EDIT_SYSTEM : CANVAS_SYSTEM) : '') },
      ...(editMode ? [{ role: 'system', content: `Current canvas code:\n\n\`\`\`html\n${canvasHtml}\n\`\`\`` }] : []),
      ...(current.summary ? [{ role: 'system', content: `Earlier in this conversation, compressed:\n${current.summary}` }] : []),
      ...current.messages.slice(current.upto).slice(-24),
    ];
    abort = new AbortController();
    $('#send').classList.add('stop');
    let full = '', lastCanvas = 0, mood = null, route = '', started = false;
    /* If the reply takes a while to start, jio stops waiting politely in its
       slot and goes and looks at the message it was asked about — round the
       sides, underneath, over the top (see Mascot.inspect). Only for a real
       wait: under a couple of seconds it would just read as twitchiness. */
    const inspectAt = setTimeout(() => {
      if (!started && !abort?.signal.aborted) mascot.inspect(userNode.querySelector('.bubble'));
    }, 2400);
    try {
      // The local model is fast and free to call twice — a real one-line plan,
      // streamed live into the thinking indicator, reads as it actually
      // thinking rather than cycling canned phrases while it works.
      if ($('#model').value === 'local' && !editMode) {
        await localThinkingPreview(bubble, messages, abort.signal);
      }
      full = await Data.stream({
        model: $('#model').value, messages, signal: abort.signal,
        temperature: editMode ? 0.2 : 0.7,
        onRoute: (r) => { route = r; },
        onToken: (_, sofar) => {
          // the first token means it is no longer thinking: stop the field,
          // call off the inspection and put the mascot back in its slot
          if (!started) { started = true; clearTimeout(inspectAt); mascot.stopInspect(); }
          if (!mood) { const m = moodIn(sofar); if (m) { mood = m; mascot.set(m); } }
          // an edit-mode reply is diff markup, not prose — nothing worth
          // streaming live; the thinking indicator stays up until it's ready
          if (editMode) return;
          const shown = stripMood(sofar).replace(PARTIAL, '');
          const split = codeSplit(shown);
          if (split) {
            streamCollapsedCode(bubble, split);
            // the code is collapsed, so nothing here grows the thread — no
            // need to chase the bottom on every token any more
            if (!bubble._codeScrolled) { scrollBottom(); bubble._codeScrolled = true; }
          } else {
            setBubble(bubble, shown, true);
            scrollBottom();
          }
          if (canvasMode && Date.now() - lastCanvas > 400) { const h = extractHtml(shown); if (h) { openCanvas(h, true); lastCanvas = Date.now(); } }
        },
      });
      if (!mood) mood = moodIn(full);
      full = stripMood(full);
      if (editMode) {
        const { html: edited, applied, failed } = applyEdits(canvasHtml, full);
        const fullBlock = extractHtml(full);
        let display = stripEditBlocks(full), snapshot;
        if (applied) {
          openCanvas(edited);
          snapshot = edited;
          display += `\n\n<div class="canvas-chip" data-open><span>▣</span><b>${applied} edit${applied > 1 ? 's' : ''} applied</b></div>\n`;
        } else if (fullBlock) {
          // ignored the diff instruction and resent the whole file — still works
          openCanvas(fullBlock);
          snapshot = fullBlock;
          display = stripHtmlBlock(full);
        }
        if (failed) display += `\n\n_${failed} edit${failed > 1 ? 's' : ''} couldn't be matched to the current code — try again or rephrase._`;
        setBubble(bubble, display || full, false, snapshot);
      } else {
        setBubble(bubble, full, false);
        const h = extractHtml(full); if (h) openCanvas(h);
      }
      showRoute(route);
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
      clearTimeout(inspectAt); mascot.stopInspect();
      abort = null; $('#send').classList.remove('stop');
      current.messages.push({ role: 'assistant', content: full });
      if (current.id) {
        Data.addMessage(current.id, 'assistant', full).catch(() => {});
        Data.touchChat(current.id).catch(() => {});
      }
      $('#input').focus();
    }
  }

  /* ---------- research mode: jio driving a real browser ----------
     Desktop-only (needs an OS-level Chromium window — see desktop/src/browser.js
     and window.jioDesktop.browser, exposed by preload.js). A plain-text ReAct
     loop rather than native tool-calling: this codebase already hit a model
     hallucinating <tool_call> XML nobody asked for (see CANVAS_EDIT_SYSTEM's
     own note above), and a loop that works identically across four unrelated
     providers can't lean on any one of their function-calling formats anyway.
     One ACTION: line per turn, the result comes back as the next OBSERVATION.

     Vision: only gemini's endpoint here is verified to accept OpenAI-shaped
     image content, so it alone gets a screenshot alongside the same numbered
     text reading every model gets — "text based navigation" is the universal
     path, a screenshot is the bonus a vision-capable model gets on top. */
  const RESEARCH_STEPS = 14;
  // duckduckgo's html-only endpoint, not google: no consent interstitial, no
  // heavy client-side rendering to fight through on a fresh cookie-less
  // session (exactly what this embedded view always is) — a search a text
  // extraction can actually read cleanly on the first try.
  const SEARCH_URL = 'https://duckduckgo.com/html/?q=';
  const RESEARCH_SYSTEM = `You are jio, driving a real web browser to research the user's request. You can see either a numbered list of the page's clickable/typeable elements and its visible text, or — when noted — a screenshot alongside that same numbering.

After a short line or two of reasoning, end your reply with EXACTLY one line in this exact form and nothing else on it:
ACTION: name(args)

Do NOT use JSON, XML, markdown code fences, or any tool-call/function-call syntax — a single plain ACTION: line, always the last line of your reply.

Available actions:
  navigate("https://...")   go straight to a URL. If the task names a specific site, go there directly — do not search for it. Only search when you genuinely don't know where the answer lives, using ${SEARCH_URL}your+query
  click(N)                  click the numbered element from the observation you were just shown
  type(N, "text")           type into numbered input/textarea N (does not submit)
  enter(N)                  press Enter in numbered field N (submits most search/forms)
  scroll("down") / scroll("up")
  back()
  done("your answer")       you have enough — this ends research; the text becomes your reply to the user

Rules:
- Exactly one ACTION per turn.
- Numbers refer only to the most recent observation — if the page changed, re-read before clicking.
- If the task names or clearly implies a specific site (a URL, a company, "on GitHub", "on Wikipedia"...), navigate() straight there. Search only as a last resort for something you cannot otherwise locate.
- NEVER search for the same or a rephrased query twice in a row. After a search's results come back, your very next action must be click(N) into one of them — not another navigate() search. If the results are genuinely useless, try ONE different query, then commit to clicking something.
- Call done(...) the moment you can answer. If you're running out of turns, call done() with your best answer and say plainly what you could not confirm.`;

  function parseAction(text) {
    const lines = text.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^ACTION:\s*(\w+)\((.*)\)\s*$/);
      if (!m) continue;
      const [, name, rawArgs] = m;
      const args = [];
      const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]+))\s*(?:,|$)/g;
      let a; while ((a = re.exec(rawArgs)) && a[0]) {
        if (a[1] !== undefined) args.push(a[1].replace(/\\(.)/g, '$1'));
        else if (a[2] !== undefined) args.push(a[2].replace(/\\(.)/g, '$1'));
        else if (a[3] !== undefined && a[3].trim()) args.push(a[3].trim());
        if (re.lastIndex >= rawArgs.length) break;
      }
      return { name, args };
    }
    return null;
  }

  const RESEARCH_ICON = { navigate: '🌐', click: '🖱', type: '⌨️', enter: '⏎', scroll: '↕️', back: '↩️' };
  function logStep(logEl, text) {
    const line = document.createElement('div');
    line.className = 'research-step';
    line.textContent = text;
    logEl.appendChild(line);
    scrollBottom();
    return line;
  }

  async function runResearch(text, bubble) {
    bubble.innerHTML = '<div class="research-log"></div>';
    const logEl = bubble.querySelector('.research-log');
    abort = new AbortController();
    $('#send').classList.add('stop');
    mascot.work();

    const model = $('#model').value === 'auto' ? 'gemini' : $('#model').value;
    // $('#model')'s values are bare provider names ('gemini', 'groq', ...), not
    // "provider:model" — Models.providerOf() assumes the latter and would
    // misread a bare id, so compare directly instead
    const vision = model === 'gemini';
    logStep(logEl, vision ? '👁 researching with vision — opening browser…' : '📄 researching (text navigation) — opening browser…');

    let full = 'research stopped before reaching an answer.';
    let route = '';
    let searchStreak = 0;
    let repeatStreak = 0, lastSig = '';
    try {
      // duckduckgo's html endpoint again, not google — same consent-wall/heavy-JS
      // reason as SEARCH_URL above, and it means the very first thing the model
      // sees is already the kind of page it'll be reading all session
      const first = await window.jioDesktop.browser.navigate('https://duckduckgo.com/html/');
      const urlEl = $('#research-url'); if (urlEl) urlEl.textContent = first.url;
      const messages = [
        { role: 'system', content: RESEARCH_SYSTEM },
        { role: 'user', content: `Research task: ${text}\n\nCurrent page (${first.url} — "${first.title}"):\n${first.elements.join('\n') || '(no interactive elements found)'}\n\nPage text:\n${first.text}` },
      ];

      for (let step = 0; step < RESEARCH_STEPS; step++) {
        const reply = await Data.stream({
          model, messages, signal: abort.signal, temperature: 0.3,
          onRoute: (r) => { route = r; },
          onToken: () => {},
        });
        const action = parseAction(reply);
        if (!action) { full = stripMood(reply) || full; logStep(logEl, '⚠ lost the thread — stopping with what it has'); break; }

        if (action.name === 'done') { full = action.args[0] || stripMood(reply); logStep(logEl, '✅ done'); break; }

        // A hard guard against the exact loop this mode used to fall into:
        // the model re-searching over and over instead of ever clicking a
        // result. Prompt rules alone don't reliably stop a model from doing
        // this, so back them with a code-level nudge that gets louder the
        // longer it keeps happening, independent of whether the model reads
        // (or follows) the system prompt's own rule against it.
        const isSearch = action.name === 'navigate' && /[?&]q=/.test(action.args[0] || '');
        searchStreak = isSearch ? searchStreak + 1 : 0;

        // The same guard, generalised: a model can get just as stuck repeating
        // any one action — most often scroll() on an endless JS feed, where
        // each scroll looks like progress but the readable text never really
        // changes. Count identical consecutive actions and say so.
        const sig = `${action.name}(${(action.args || []).join(',')})`;
        repeatStreak = sig === lastSig ? repeatStreak + 1 : 0;
        lastSig = sig;

        let obs, desc;
        try {
          switch (action.name) {
            case 'navigate': desc = `${RESEARCH_ICON.navigate} ${action.args[0]}`; obs = await window.jioDesktop.browser.navigate(action.args[0]); break;
            case 'click': desc = `${RESEARCH_ICON.click} click [${action.args[0]}]`; obs = await window.jioDesktop.browser.click(action.args[0]); break;
            case 'type': desc = `${RESEARCH_ICON.type} type "${action.args[1]}" into [${action.args[0]}]`; obs = await window.jioDesktop.browser.type(action.args[0], action.args[1]); break;
            case 'enter': desc = `${RESEARCH_ICON.enter} enter on [${action.args[0]}]`; obs = await window.jioDesktop.browser.pressEnter(action.args[0]); break;
            case 'scroll': desc = `${RESEARCH_ICON.scroll} scroll ${action.args[0] || 'down'}`; obs = await window.jioDesktop.browser.scroll(action.args[0]); break;
            case 'back': desc = `${RESEARCH_ICON.back} back`; obs = await window.jioDesktop.browser.back(); break;
            default: desc = `⚠ unknown action "${action.name}"`; obs = await window.jioDesktop.browser.read();
          }
        } catch (e) { obs = await window.jioDesktop.browser.read().catch(() => null); desc = `⚠ ${action.name} failed: ${e.message}`; }
        logStep(logEl, desc || action.name);
        if (urlEl && obs) urlEl.textContent = obs.url;

        messages.push({ role: 'assistant', content: reply });
        let obsText = obs
          ? `OBSERVATION — ${obs.url} — "${obs.title}":\n${obs.elements.join('\n') || '(no interactive elements found)'}\n\nPage text:\n${obs.text}`
          : 'OBSERVATION: that action failed and the page could not be re-read.';
        if (searchStreak >= 2) {
          obsText = `IMPORTANT: that's ${searchStreak} searches in a row with no click in between. Do not search again — click(N) on one of the results below, or call done() if you already have enough.\n\n${obsText}`;
        }
        if (repeatStreak >= 2) {
          obsText = `IMPORTANT: you have now run ${repeatStreak + 1} identical actions in a row (${sig}) and the page is not getting you anywhere new. Stop repeating it — do something different: click(N) on one of the elements below, navigate() somewhere else, or call done() with what you already have. Some pages (endless video/social feeds especially) render almost nothing a text reading can use, so more of the same will not help.\n\n${obsText}`;
        }
        if (vision) {
          const shot = await window.jioDesktop.browser.screenshot().catch(() => null);
          messages.push({ role: 'user', content: shot
            ? [{ type: 'text', text: obsText }, { type: 'image_url', image_url: { url: `data:image/png;base64,${shot}` } }]
            : obsText });
        } else {
          messages.push({ role: 'user', content: obsText });
        }
        if (step === RESEARCH_STEPS - 1) { full = 'reached the research step limit before finding a confident answer.'; logStep(logEl, '⏱ step limit reached'); }
      }
      const answer = document.createElement('div');
      answer.className = 'research-answer';
      answer.innerHTML = render(full);
      renderMath(answer);
      bubble.appendChild(answer);
      scrollBottom();
      showRoute(route);
      mascot.done(true);
    } catch (err) {
      if (err.name === 'AbortError') { logStep(logEl, '⏹ stopped'); full = full || '_stopped_'; mascot.done(true); }
      else { logStep(logEl, `⚠ ${err.message}`); full = `error: ${err.message}`; mascot.done(false); }
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
    if (!app.classList.contains('canvas-open')) app.classList.add('canvas-open');
    $('#canvas-empty').hidden = true;
    $('#canvas-code').textContent = html;
    if (!partial || html.length % 7 === 0) $('#canvas-frame').srcdoc = html;
  }
  /* A new or freshly-opened chat starts with no canvas of its own — otherwise
     an edit-mode request would diff against the PREVIOUS chat's code. */
  function resetCanvas() {
    canvasHtml = '';
    app.classList.remove('canvas-open');
    $('#canvas-empty').hidden = false;
    $('#canvas-code').textContent = '';
    $('#canvas-frame').srcdoc = '';
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

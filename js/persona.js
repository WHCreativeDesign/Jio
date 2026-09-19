/* Persona — who jio is when it isn't answering anything.

   Personality in a chat app is usually taken to mean the system prompt, and
   the system prompt is genuinely half of it (see SYSTEM in js/chat.js). This
   file is the other half: the part that has nothing to do with the model.

   Two jobs.

   Voice. Every line the interface says in the first person lives here, and
   every one of them has several phrasings that don't repeat back to back. An
   app that says the exact same sentence the fiftieth time you delete a chat
   is a machine with a label on it; one that varies is something with a mood.

   Attention. jio's eyes are on screen the entire time you use it, so where
   they point is a continuous statement about what it is paying attention to.
   They follow your pointer through the thread, look at the composer while you
   type, flick to whatever you just opened, and drift off if you leave. None
   of it is decoration — it is the difference between a face that is present
   and a face that is playing back. */
(function (global) {
  'use strict';

  /* ---------- voice ----------
     Picks from a set without repeating the previous pick, so variety is
     actually felt rather than merely available. */
  const lastPick = new Map();
  function pick(key, list) {
    if (list.length === 1) return list[0];
    const prev = lastPick.get(key);
    let choice;
    do { choice = list[(Math.random() * list.length) | 0]; } while (choice === prev);
    lastPick.set(key, choice);
    return choice;
  }

  const GREETINGS = {
    late: ['up late, {name}', 'still going, {name}', 'the quiet hours, {name}'],
    morning: ['good morning, {name}', 'morning, {name}', 'early start, {name}'],
    afternoon: ['good afternoon, {name}', 'afternoon, {name}', 'back at it, {name}'],
    evening: ['good evening, {name}', 'evening, {name}', 'winding down, {name}'],
  };

  function greeting(name) {
    const h = new Date().getHours();
    const slot = h < 5 ? 'late' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return pick('greet', GREETINGS[slot]).replace('{name}', name);
  }

  const PROMPTS = [
    'What are we making?',
    'What should jio build?',
    'Start anywhere.',
    'What is on your mind?',
    'Say the idea out loud.',
  ];
  const placeholder = () => pick('placeholder', PROMPTS);

  /* ---------- the questions ----------
     One entry per irreversible thing the app can do. Each is written as jio
     speaking, and each names the specific thing rather than "this item" —
     "delete every chat" is a question you can actually answer, "are you sure?"
     is not. The confirm label restates the action too, because a button that
     says OK tells you nothing about what OK does. */
  const ASKS = {
    deleteChat: (t) => ({
      title: pick('dc', ['Delete this chat?', 'Throw this one away?', 'Drop this chat?']),
      body: t ? `"${t}" and everything in it. jio can't get it back.` : "Everything in it goes too, and jio can't get it back.",
      confirm: 'Delete chat', cancel: 'Keep it', danger: true,
    }),
    clearChats: (n) => ({
      title: 'Delete every chat?',
      body: `All ${n} of them, permanently. What jio remembers about you stays — the conversations don't.`,
      confirm: `Delete all ${n}`, cancel: 'Never mind', danger: true, mood: 'surprised',
    }),
    forgetMemory: (t) => ({
      title: pick('fm', ['Forget this?', 'Let this one go?']),
      body: t ? `jio stops carrying "${t}" into new conversations.` : 'jio stops carrying it into new conversations.',
      confirm: 'Forget it', cancel: 'Keep it', danger: true, mood: 'sad',
    }),
    removeKey: (label) => ({
      title: 'Take this key out of the pool?',
      body: `${label || 'It'} stops serving requests for everyone the moment it goes. You can always donate it again.`,
      confirm: 'Remove key', cancel: 'Leave it', danger: true,
    }),
    signOut: (name) => ({
      title: pick('so', ['Sign out?', 'Leaving?']),
      body: `Your chats and everything jio remembers stay put, ${name}. You just won't see them until you're back.`,
      confirm: 'Sign out', cancel: 'Stay', danger: false, mood: 'sad',
    }),
    /* Deliberately NOT here: stopping a reply. It destroys nothing — whatever
       jio has already said stays on screen — and a stop button you have to
       confirm is a stop button that doesn't work. Speed is the whole feature. */
    discardCanvas: () => ({
      title: 'Start a new canvas?',
      body: "The code on screen isn't saved anywhere else — a new chat starts it from nothing.",
      confirm: 'New canvas', cancel: 'Keep this one', danger: true,
    }),
  };

  /* ---------- receipts ---------- */
  const DONE = {
    deleteChat: ['chat deleted', 'gone', 'that one is gone'],
    clearChats: ['every chat deleted'],
    forgetMemory: ['forgotten', 'jio will stop bringing that up'],
    addMemory: ['jio will remember that', 'noted', 'kept'],
    saveMemory: ['saved'],
    removeKey: ['key removed from the pool'],
    addKey: ['key added — thanks for feeding jio', 'in the pool, thank you'],
    copied: ['copied', 'on your clipboard'],
    kept: ['left alone', 'kept'],
  };
  const done = (kind) => pick('done:' + kind, DONE[kind] || [kind]);

  /* ---------- moods ----------
     The model picks a word; this is the map from that word to a face. Kept
     here rather than in the engine because it is a matter of character, not
     geometry: which of the twenty-odd expressions jio actually uses, and what
     it falls back to for a word it wasn't expecting. */
  const MOOD_ALIAS = {
    thinking: 'focused', working: 'focused', amused: 'mischief', playful: 'mischief',
    proud: 'proud', excited: 'excited', idea: 'inspired', creative: 'inspired',
    impressed: 'wonder', pleased: 'delight', unsure: 'confused', wary: 'suspicious',
    tired: 'sleepy', sorry: 'sad',
  };
  function mood(word) {
    if (!word) return null;
    const w = String(word).toLowerCase();
    if (global.JioEyes && global.JioEyes.EXPR[w]) return w;
    return MOOD_ALIAS[w] || null;
  }

  /* ---------- attention ----------
     Where the eyes point, and why. Everything below is passive: it observes
     what you are already doing and never takes focus, opens anything, or
     interrupts a reply in progress. */
  function attach(mascot, opts = {}) {
    if (!mascot) return;
    const wrap = opts.wrap || document.getElementById('thread-wrap');
    const input = opts.input || document.getElementById('input');
    const eyes = mascot.eyes;

    // The engine applies a gaze when either `track` or `idle` is on, and the
    // idle wander rewrites the gaze target every second or two — so pointer
    // tracking has to hold the wander off while it is actually driving.
    let holdUntil = 0;
    const claim = (ms) => { holdUntil = performance.now() + ms; eyes.idle = false; };
    const release = () => { if (performance.now() >= holdUntil) eyes.idle = true; };
    setInterval(release, 400);

    // is the mascot doing something it shouldn't be interrupted during?
    const engaged = () => mascot.busy || mascot._inspect || mascot._judging;

    const lookAtPoint = (cx, cy) => {
      if (engaged() || !mascot.cur) return;
      const b = wrap.getBoundingClientRect();
      const ex = b.left + mascot.cur.x - wrap.scrollLeft + mascot.cur.w / 2;
      const ey = b.top + mascot.cur.y - wrap.scrollTop + mascot.cur.h / 2;
      // Falloff rather than a hard clamp: something far away saturates the
      // look instead of pinning it rigidly to the rim.
      eyes.look(Math.tanh((cx - ex) / 220), Math.tanh((cy - ey) / 150));
      claim(2200);
    };

    /* Pointer tracking, coalesced to one sample per frame — a fast mouse
       fires hundreds of pointermove events a second and none of the extra
       ones can be seen. The sampler registers itself on the clock only for
       the frame it is needed and unregisters immediately after, so a still
       pointer costs nothing and never holds the shared loop awake. */
    let px = 0, py = 0, sampling = false;
    const sample = () => { sampling = false; global.Motion.remove(sample); lookAtPoint(px, py); };
    wrap?.addEventListener('pointermove', (e) => {
      px = e.clientX; py = e.clientY;
      if (sampling) return;
      sampling = true;
      global.Motion.add(sample);
    }, { passive: true });

    /* Typing. jio looks down at what you are writing, and it is the composer
       it looks at, not the caret — following individual characters would read
       as twitchy rather than attentive. */
    let typingT = 0;
    const atComposer = () => {
      if (engaged()) return;
      const r = input?.getBoundingClientRect();
      if (r) lookAtPoint(r.left + r.width * 0.3, r.top + r.height / 2);
    };
    input?.addEventListener('input', () => {
      atComposer();
      clearTimeout(typingT);
      // a pause long enough to be a pause, not a breath between words
      typingT = setTimeout(() => { if (!engaged()) mascot.react('curious', 1200); }, 2600);
    });
    input?.addEventListener('focus', atComposer);

    /* Going quiet. Nobody has touched anything for a while, so neither does
       jio — it looks away, then eventually dozes. Any activity resets it. */
    let idleAt = Date.now();
    const poke = () => {
      idleAt = Date.now();
      if (eyes.name === 'sleeping' || eyes.name === 'sleepy') mascot.set('neutral');
    };
    ['pointerdown', 'keydown', 'wheel'].forEach(ev =>
      document.addEventListener(ev, poke, { passive: true }));
    setInterval(() => {
      if (engaged() || document.hidden) return;
      const quiet = (Date.now() - idleAt) / 1000;
      if (quiet > 240 && eyes.name !== 'sleeping') mascot.set('sleeping');
      else if (quiet > 75 && eyes.name === 'neutral') mascot.set('sleepy');
    }, 5000);
  }

  global.Persona = { greeting, placeholder, ask: ASKS, done, mood, attach, pick };
})(window);

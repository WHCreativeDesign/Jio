/* JIO eye engine — geometric rounded-rect eyes in the Vector / Cozmo / EMO
   lineage, driven by springs rather than tweens.

   Two eyes and no face is a hard brief: every bit of character has to come
   out of size, position, lid angle and timing, because there is nothing else
   on screen to carry it. So the engine is built around three ideas.

   Springs, not lerps. Each eye's shape is a set of springs pulling toward the
   current expression, which means an expression that changes mid-morph
   redirects with its existing momentum instead of restarting, and a big move
   arrives with a touch of overshoot. That overshoot is the whole difference
   between a shape being interpolated and a thing being alive.

   Life at rest. A face that holds perfectly still between events reads as
   frozen, not calm. Even at "neutral" the eyes breathe, drift on smooth
   noise, and flick microsaccades — tiny, fast gaze corrections, the thing
   real eyes do constantly and animated ones almost never do.

   Sleep when nothing is happening. All of the above still settles: when every
   spring is at rest, no effect is running and no blink is due, the instance
   stops painting entirely and costs nothing until something changes. */
(function (global) {
  'use strict';

  const { damp, lerp, clamp, noise, Spring, Ease } = global.Motion;

  const BASE = {
    w: 1, h: 1, dx: 0, dy: 0, rot: 0,
    r: [0.45, 0.45, 0.45, 0.45],        // tl, tr, br, bl — fraction of min(w,h)/2
    topIn: 0, topOut: 0,                // upper lid coverage at inner / outer edge (0..1)
    botIn: 0, botOut: 0,                // lower lid coverage
    shape: 0,                           // 0 rect, 1 heart, 2 cross, 3 bar
    alpha: 1
  };

  const E = (l, r, fx) => ({ L: { ...BASE, ...l }, R: { ...BASE, ...(r || l) }, fx: fx || null });
  const both = (p, fx) => E(p, p, fx);

  // Expressions. "In" = toward nose, "Out" = toward temple. Mirrored automatically for the right eye.
  const EXPR = {
    neutral:    both({}),
    happy:      both({ h: 0.78, botIn: 0.55, botOut: 0.55, r: [0.9, 0.9, 0.2, 0.2] }),
    laugh:      both({ h: 0.6, botIn: 0.7, botOut: 0.7, r: [1, 1, 0.1, 0.1] }, 'bounce'),
    excited:    both({ w: 1.15, h: 1.2, r: [0.6, 0.6, 0.6, 0.6] }, 'pulse'),
    love:       both({ shape: 1, w: 1.2, h: 1.2 }, 'beat'),
    sad:        both({ h: 0.85, topIn: 0.05, topOut: 0.45, r: [0.5, 0.5, 0.7, 0.7], dy: 0.12 }),
    cry:        both({ h: 0.8, topIn: 0.1, topOut: 0.5, dy: 0.15 }, 'tears'),
    angry:      both({ h: 0.8, topIn: 0.5, topOut: 0.05, r: [0.2, 0.2, 0.5, 0.5] }),
    rage:       both({ h: 0.65, topIn: 0.6, topOut: 0.05, r: [0.1, 0.1, 0.4, 0.4] }, 'shake'),
    surprised:  both({ w: 1.2, h: 1.35, r: [0.8, 0.8, 0.8, 0.8] }),
    scared:     both({ w: 0.75, h: 0.75, r: [0.9, 0.9, 0.9, 0.9] }, 'tremble'),
    sleepy:     both({ h: 0.5, topIn: 0.45, topOut: 0.45, dy: 0.2, r: [0.3, 0.3, 0.6, 0.6] }, 'drift'),
    sleeping:   both({ shape: 3, h: 0.14, dy: 0.25 }, 'zz'),
    wink:       E({ h: 0.14, shape: 3, dy: 0.1 }, { h: 0.85, botIn: 0.45, botOut: 0.45, r: [0.9, 0.9, 0.2, 0.2] }),
    suspicious: both({ h: 0.5, topIn: 0.25, topOut: 0.35, botIn: 0.2, botOut: 0.2, r: [0.2, 0.2, 0.2, 0.2] }),
    confused:   E({ h: 0.6, topIn: 0.35, topOut: 0.15, r: [0.3, 0.3, 0.3, 0.3] }, { w: 1.1, h: 1.15, r: [0.7, 0.7, 0.7, 0.7], dy: -0.08 }),
    curious:    E({ w: 1.15, h: 1.25, r: [0.7, 0.7, 0.7, 0.7], dy: -0.08 }, { h: 0.9 }, 'tilt'),
    focused:    both({ h: 0.55, r: [0.25, 0.25, 0.25, 0.25], w: 1.1 }),
    bored:      both({ h: 0.55, topIn: 0.4, topOut: 0.4, r: [0.15, 0.15, 0.5, 0.5], dy: 0.1 }, 'sigh'),
    smirk:      E({ h: 0.7, topIn: 0.15, topOut: 0.3, r: [0.4, 0.4, 0.4, 0.4] }, { h: 0.8, botIn: 0.5, botOut: 0.3, r: [0.9, 0.9, 0.2, 0.2] }),
    proud:      both({ h: 0.7, topIn: 0.3, topOut: 0.3, botIn: 0.2, botOut: 0.2, r: [0.3, 0.3, 0.6, 0.6], dy: -0.05 }),
    dizzy:      both({ w: 0.95, h: 0.95, r: [0.9, 0.9, 0.9, 0.9] }, 'spin'),
    dead:       both({ shape: 2, w: 0.95, h: 0.95 }),
    glitch:     both({}, 'glitch'),
    scanning:   both({ shape: 3, h: 0.22, w: 1.15, r: [0.5, 0.5, 0.5, 0.5] }, 'scan'),
    loading:    both({ w: 0.8, h: 0.8, r: [1, 1, 1, 1] }, 'orbit'),

    /* ---------- the creative register ----------
       jio makes things, so it needs the faces that go with making things: the
       moment an idea lands, the pleasure of a good result, the narrowed focus
       of real work, the sideways look of an idea it isn't sure it should
       admit to. These are the moods the model can actually reach for (see
       SYSTEM and Persona.mood) — the set above is the emotional floor they
       sit on. */
    inspired:   both({ w: 1.1, h: 1.22, dy: -0.06, r: [0.75, 0.75, 0.75, 0.75] }, 'spark'),
    delight:    both({ h: 0.72, botIn: 0.62, botOut: 0.52, r: [1, 1, 0.15, 0.15], dy: -0.04 }, 'bob'),
    wonder:     both({ w: 1.12, h: 1.3, r: [0.85, 0.85, 0.85, 0.85], dy: -0.04 }, 'shimmer'),
    determined: both({ h: 0.62, topIn: 0.34, topOut: 0.06, w: 1.08, r: [0.18, 0.18, 0.42, 0.42] }, 'lockon'),
    mischief:   E({ h: 0.52, topIn: 0.3, topOut: 0.1, r: [0.25, 0.25, 0.5, 0.5] }, { h: 0.74, botIn: 0.55, botOut: 0.25, r: [0.95, 0.95, 0.2, 0.2] }, 'lean'),
    shy:        both({ h: 0.6, topIn: 0.3, topOut: 0.36, dy: 0.14, r: [0.5, 0.5, 0.55, 0.55] }, 'sway'),
    blink:      both({ h: 0.06, w: 1.06, shape: 3 }),
  };

  /* Effects that erase pixels (destination-out) and therefore need an
     offscreen buffer when a background is painted underneath them. Every
     other expression draws straight onto the visible canvas — that round
     trip used to cost a full-canvas drawImage on every single frame, for
     every instance, whether or not anything needed it. */
  const CUTOUT_FX = new Set(['scan', 'orbit']);
  /* Effects that never settle: while one is running the instance keeps
     painting even if every spring is at rest. */
  const LIVE_FX = new Set([
    'bounce', 'pulse', 'beat', 'shake', 'tremble', 'drift', 'tilt', 'sigh',
    'glitch', 'tears', 'zz', 'scan', 'orbit', 'spin',
    'spark', 'bob', 'shimmer', 'lockon', 'lean', 'sway',
  ]);

  /* Blink shape. A real blink is not symmetric — the lid slams shut in about
     a twelfth of a second and peels back open over twice that. Matching those
     two numbers is most of what makes a synthetic blink stop looking like a
     shape being scaled. */
  const BLINK_CLOSE = 0.075, BLINK_OPEN = 0.135;
  const BLINK_TOTAL = BLINK_CLOSE + BLINK_OPEN;

  const SPRING_KEYS = ['w', 'h', 'dx', 'dy', 'rot'];
  const DAMP_KEYS = ['topIn', 'topOut', 'botIn', 'botOut', 'alpha'];

  const cloneEye = (e) => ({ ...e, r: [...e.r] });

  class Eyes {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.color = opts.color || '#ffffff';
      this.bg = opts.bg || null;
      this.speed = opts.speed || 14;
      this.gap = opts.gap || 0.55;         // gap between eyes, as fraction of eye width
      this.size = opts.size || 0.34;       // eye width as fraction of canvas height
      this.autoBlink = opts.autoBlink !== undefined ? opts.autoBlink : true;
      this.idle = !!opts.idle;
      this.track = opts.track !== undefined ? opts.track : true;
      /* Ambient life, independent of expression: a slow breath and a smooth
         drift, so the face is never perfectly static. Off for the tiny inline
         instances where a 1px bob would just read as a rendering wobble. */
      this.alive = opts.alive !== undefined ? opts.alive : true;
      this.glow = opts.glow || 0;          // emissive bloom, in eye-widths
      this.shading = opts.shading !== undefined ? opts.shading : true;
      this.seed = Math.random() * 100;

      this.cur = { L: cloneEye(BASE), R: cloneEye(BASE) };
      this.springs = { L: {}, R: {} };
      for (const side of ['L', 'R']) {
        for (const k of SPRING_KEYS) {
          this.springs[side][k] = new Spring(BASE[k], { stiffness: 210, damping: 21 });
        }
      }
      this.name = 'neutral';
      this.expr = EXPR.neutral;
      this.gaze = { x: 0, y: 0 }; this.gazeT = { x: 0, y: 0 };
      this.saccade = { x: 0, y: 0 }; this.nextSaccade = 0.6 + Math.random();
      this.blinkT = -1; this.nextBlink = 2 + Math.random() * 3;
      this.idleT = 0; this.t = 0;
      this.impulse = 0;        // squash-and-stretch kick on expression change
      this.onFrame = null;
      this._running = false;
      this._dirty = true;
      this._visible = true;
      this.resize();
      this.step = this.step.bind(this);
      this.watchCanvas();
    }

    /* Two observers on the canvas.

       Visibility: an instance scrolled out of view, or sitting on a hidden
       view, still burned a full animation loop. It now stops at the edge of
       the viewport and picks straight back up on the way in.

       Size: the backing store is only right for the CSS box it was measured
       against, and some of these canvases genuinely resize — the live stage's
       eyes shrink once there is an answer to read. Without this they stayed
       at their old resolution and got scaled by the browser, which is
       precisely the soft, slightly smeared look a canvas should never have. */
    watchCanvas() {
      if (global.IntersectionObserver) {
        this._io = new IntersectionObserver((entries) => {
          this._visible = entries[entries.length - 1].isIntersecting;
          if (this._visible) { this._dirty = true; global.Motion.wake(); }
        }, { rootMargin: '64px' });
        this._io.observe(this.c);
      }
      if (global.ResizeObserver) {
        // resize() is a no-op when the rounded device size is unchanged, so
        // this converges immediately rather than feeding itself.
        this._ro = new ResizeObserver(() => { this.resize(); global.Motion.wake(); });
        this._ro.observe(this.c);
      }
    }

    resize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const w = this.c.clientWidth || this.c.width, h = this.c.clientHeight || this.c.height;
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (cw !== this.c.width || ch !== this.c.height) { this.c.width = cw; this.c.height = ch; }
      this.dpr = dpr; this.W = w; this.H = h;
      this._dirty = true;
    }

    set(name) {
      if (!EXPR[name] || name === this.name) return;
      this.name = name;
      this.expr = EXPR[name];
      this.fxStart = this.t;
      // A face that changes expression instantly has no weight. The impulse is
      // a short squash-then-release applied on top of the springs, so even a
      // small mood change lands with a beat of its own.
      this.impulse = 1;
      this.wake();
    }
    list() { return Object.keys(EXPR).filter(k => k !== 'blink'); }
    blink() { if (this.blinkT < 0) { this.blinkT = 0; this.wake(); } }
    look(nx, ny) {
      const x = clamp(nx, -1, 1), y = clamp(ny, -1, 1);
      if (x !== this.gazeT.x || y !== this.gazeT.y) { this.gazeT.x = x; this.gazeT.y = y; this.wake(); }
    }
    wake() { this._dirty = true; global.Motion.wake(); }

    start() {
      if (this._running) return;
      this._running = true;
      this._dirty = true;
      global.Motion.add(this.step);
    }
    stop() {
      if (!this._running) return;
      this._running = false;
      global.Motion.remove(this.step);
    }
    /* Releases the observer too — an instance that is never coming back
       should not keep a live callback pointed at a detached canvas. */
    destroy() {
      this.stop();
      this._io?.disconnect(); this._io = null;
      this._ro?.disconnect(); this._ro = null;
    }

    /* The paint budget. Three tiers, and which one applies is decided every
       frame:

         busy      — something is genuinely animating: paint every frame.
         ambient   — nothing is, but the face still breathes: paint at 30Hz.
         asleep    — not even that (alive: false): paint nothing at all.

       The middle tier is the interesting one. Breathing is a 1px sine over a
       full second; at 30Hz it is indistinguishable from 60, and it halves the
       cost of a face that is just sitting there — which, across a session, is
       almost all of the time. */
    step(dt) {
      this.t += dt;
      this.update(dt);
      if (!this._visible) return;
      if (this.restless() || this._dirty) {
        this.draw(); this._dirty = false; this._ambient = 0;
      } else if (this.alive) {
        this._ambient = (this._ambient || 0) + dt;
        if (this._ambient >= 1 / 30) { this._ambient = 0; this.draw(); }
      }
      if (this.onFrame) this.onFrame(this);
    }

    /* Is anything still moving? Everything that animates has to be able to
       answer this, because "no" is what drops the instance down a tier.
       Ambient breathing deliberately does not count — it never settles, and
       treating it as motion would pin every face at full rate forever. */
    restless() {
      if (this.blinkT >= 0 || this.impulse > 0.002) return true;
      if (LIVE_FX.has(this.expr.fx)) return true;
      if (Math.abs(this.gaze.x - this.gazeT.x) > 0.001 || Math.abs(this.gaze.y - this.gazeT.y) > 0.001) return true;
      if (Math.abs(this.saccade.x) > 0.001 || Math.abs(this.saccade.y) > 0.001) return true;
      for (const side of ['L', 'R']) {
        for (const k of SPRING_KEYS) if (!this.springs[side][k].settled) return true;
        const c = this.cur[side], t = this.expr[side];
        for (const k of DAMP_KEYS) if (Math.abs(c[k] - t[k]) > 0.002) return true;
        for (let i = 0; i < 4; i++) if (Math.abs(c.r[i] - t.r[i]) > 0.002) return true;
      }
      return false;
    }

    update(dt) {
      // blink timer
      if (this.autoBlink && this.blinkT < 0 && this.name !== 'sleeping' && this.name !== 'dead') {
        this.nextBlink -= dt;
        if (this.nextBlink <= 0) {
          this.blinkT = 0;
          // Blinks cluster in real faces: usually a single, occasionally a
          // quick double. A perfectly regular interval is the tell.
          this.nextBlink = Math.random() < 0.18 ? 0.22 : 2.4 + Math.random() * 4.2;
        }
      }
      if (this.blinkT >= 0) { this.blinkT += dt; if (this.blinkT > BLINK_TOTAL) this.blinkT = -1; }

      this.impulse = Math.max(0, this.impulse - dt * 4.6);

      // idle wander — a destination every couple of seconds, not a jitter
      if (this.idle) {
        this.idleT -= dt;
        if (this.idleT <= 0) {
          this.idleT = 1.1 + Math.random() * 2.6;
          this.gazeT = { x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.5 };
        }
      }

      /* Microsaccades. Eyes never actually hold a fixation — they flick a
         fraction of a degree several times a second and snap back. At this
         scale that is well under a pixel of travel, and it is still the
         single cheapest thing that stops a gaze looking painted on. */
      this.nextSaccade -= dt;
      if (this.nextSaccade <= 0) {
        this.nextSaccade = 0.45 + Math.random() * 1.5;
        this.saccade.x = (Math.random() * 2 - 1) * 0.07;
        this.saccade.y = (Math.random() * 2 - 1) * 0.05;
      }
      this.saccade.x = damp(this.saccade.x, 0, 9, dt);
      this.saccade.y = damp(this.saccade.y, 0, 9, dt);

      // the gaze itself eases; saccades ride on top of it rather than through it
      this.gaze.x = damp(this.gaze.x, this.gazeT.x, 10, dt);
      this.gaze.y = damp(this.gaze.y, this.gazeT.y, 10, dt);

      // Blink is a transient blended over the expression, not a state of its
      // own — so the face keeps whatever it was doing while the lid passes.
      let tgt = this.expr, blinkMix = 0;
      if (this.blinkT >= 0) {
        blinkMix = this.blinkT < BLINK_CLOSE
          ? Ease.outQuint(this.blinkT / BLINK_CLOSE)
          : 1 - Ease.inOutCubic((this.blinkT - BLINK_CLOSE) / BLINK_OPEN);
        tgt = { L: mixEye(this.expr.L, EXPR.blink.L, blinkMix), R: mixEye(this.expr.R, EXPR.blink.R, blinkMix) };
      }

      for (const side of ['L', 'R']) {
        const c = this.cur[side], t = tgt[side], sp = this.springs[side];
        for (const k of SPRING_KEYS) c[k] = sp[k].set(t[k]).step(dt);
        // Lids and corner radii are damped, not sprung: a lid that overshoots
        // reads as a twitch, and a corner radius that overshoots ripples.
        const k = this.speed;
        for (const key of DAMP_KEYS) c[key] = damp(c[key], t[key], k, dt);
        for (let i = 0; i < 4; i++) c.r[i] = damp(c.r[i], t.r[i], k, dt);
        // shape is categorical — it swaps at the halfway point of the morph
        c.shape = t.shape;
      }
    }

    draw() {
      const { W, H, dpr } = this;
      const fx = this.expr.fx, ft = this.t - (this.fxStart || 0);
      const main = this.ctx;
      main.setTransform(dpr, 0, 0, dpr, 0, 0);
      main.clearRect(0, 0, W, H);
      if (this.bg) { main.fillStyle = this.bg; main.fillRect(0, 0, W, H); }

      // Only cutout effects over a painted background need the detour through
      // an offscreen buffer; everything else draws straight to the canvas.
      const needsBuffer = !!this.bg && CUTOUT_FX.has(fx);
      let ctx = main;
      if (needsBuffer) {
        if (!this.off || this.off.width !== this.c.width || this.off.height !== this.c.height) {
          this.off = document.createElement('canvas');
          this.off.width = this.c.width; this.off.height = this.c.height;
          this.offCtx = this.off.getContext('2d');
        }
        ctx = this.offCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
      } else if (this.off) {
        // a buffer allocated for a previous expression is dead weight now
        this.off = this.offCtx = null;
      }

      const ew = H * this.size, eh = ew * 1.15;
      const gap = ew * this.gap;
      const cx = W / 2, cy = H / 2;
      let gx = 0, gy = 0, grot = 0, gscale = 1, jitter = 0;

      /* Ambient life: a slow breath on a sine, plus a wander on smooth noise
         so the resting pose never lands twice in the same place. Both are
         sub-pixel at small sizes and unmistakable at large ones. */
      if (this.alive) {
        gy += Math.sin(this.t * 1.05 + this.seed) * eh * 0.018;
        gscale *= 1 + Math.sin(this.t * 1.05 + this.seed) * 0.008;
        gx += noise(this.t * 0.22, this.seed) * ew * 0.02;
      }

      if (fx === 'bounce') gy -= Math.abs(Math.sin(ft * 9)) * eh * 0.12;
      if (fx === 'pulse') gscale *= 1 + Math.sin(ft * 6) * 0.05;
      if (fx === 'beat') gscale *= 1 + Math.max(0, Math.sin(ft * 7)) ** 6 * 0.18;
      if (fx === 'shake') gx += Math.sin(ft * 60) * ew * 0.03;
      if (fx === 'tremble') { gx += Math.sin(ft * 45) * ew * 0.015; gy += Math.cos(ft * 38) * eh * 0.012; }
      if (fx === 'drift') gy += Math.sin(ft * 1.2) * eh * 0.05;
      if (fx === 'tilt') grot += Math.sin(ft * 1.5) * 6;
      if (fx === 'sigh') gy += Math.sin(ft * 0.9) * eh * 0.04;
      if (fx === 'glitch') jitter = Math.random() < 0.12 ? 1 : 0;
      // the creative register's own motion
      if (fx === 'bob') gy -= Math.abs(Math.sin(ft * 4.6)) * eh * 0.07;
      if (fx === 'shimmer') gscale *= 1 + Math.sin(ft * 2.4) * 0.022;
      if (fx === 'lean') grot += 5 + Math.sin(ft * 1.1) * 2;
      if (fx === 'sway') { gx += Math.sin(ft * 1.35) * ew * 0.035; grot += Math.sin(ft * 1.35) * 2.5; }
      if (fx === 'lockon') {
        // a held stare that tightens rather than moves — a pulse on the scale only
        gscale *= 1 - Math.max(0, Math.sin(ft * 3.1)) ** 3 * 0.035;
      }
      if (fx === 'spark') gy -= Math.max(0, Math.sin(ft * 2.2)) ** 2 * eh * 0.05;

      // squash and stretch, from the expression-change impulse
      const imp = this.impulse > 0 ? Math.sin(this.impulse * Math.PI) : 0;
      const sqX = 1 + imp * 0.05, sqY = 1 - imp * 0.06;

      const gaze = this.track || this.idle ? this.gaze : { x: 0, y: 0 };
      const look = {
        x: (gaze.x + this.saccade.x) * ew * 0.35,
        y: (gaze.y + this.saccade.y) * eh * 0.28,
      };
      const sideSquash = 1 - Math.abs(gaze.x) * 0.12;

      if (this.glow) {
        ctx.shadowColor = this.color;
        ctx.shadowBlur = ew * this.glow;
      }

      const drawEye = (p, side) => {
        const s = side === 'L' ? -1 : 1;
        // parallax: the eye nearer the gaze direction grows slightly, which is
        // what sells a flat pair of shapes as a head turning
        const par = 1 + gaze.x * s * 0.06;
        const w = ew * p.w * gscale * par * sideSquash * sqX, h = eh * p.h * gscale * par * sqY;
        const x = cx + s * (ew / 2 + gap / 2) + p.dx * ew * -s + look.x + gx;
        const y = cy + p.dy * eh + look.y + gy;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(((p.rot * -s) + grot) * Math.PI / 180);
        if (fx === 'spin') ctx.rotate(ft * 5 * s);
        if (jitter) ctx.translate((Math.random() - 0.5) * ew * 0.3, (Math.random() - 0.5) * eh * 0.1);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = this.color;

        const shape = p.shape;
        if (shape === 1) heart(ctx, w, h);
        else if (shape === 2) cross(ctx, w, h);
        else {
          // lids: clip visible quad. inner edge is toward center (x = -s direction)
          const inX = -s * w / 2, outX = s * w / 2;
          const topInY = -h / 2 + h * p.topIn, topOutY = -h / 2 + h * p.topOut;
          const botInY = h / 2 - h * p.botIn, botOutY = h / 2 - h * p.botOut;
          ctx.beginPath();
          ctx.moveTo(inX * 1.4, topInY - (topInY - topOutY) * 0.4);
          ctx.lineTo(outX * 1.4, topOutY - (topOutY - topInY) * 0.4);
          ctx.lineTo(outX * 1.4, botOutY - (botOutY - botInY) * 0.4);
          ctx.lineTo(inX * 1.4, botInY - (botInY - botOutY) * 0.4);
          ctx.closePath();
          ctx.clip();
          roundRect(ctx, -w / 2, -h / 2, w, h, p.r.map(r => r * Math.min(w, h) / 2));
          ctx.fill();

          /* Volume. A flat fill is a sticker; a hair of light along the top
             edge and a hair of shade along the bottom is a surface. Composited
             source-atop so it only ever lands on the eye itself, and it reads
             in both themes for free: on a dark eye the highlight does the
             work, on a light one the shade does. */
          if (this.shading) {
            ctx.shadowBlur = 0;
            ctx.globalCompositeOperation = 'source-atop';
            const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
            g.addColorStop(0, 'rgba(255,255,255,0.20)');
            g.addColorStop(0.45, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(0,0,0,0.14)');
            ctx.fillStyle = g;
            ctx.fillRect(-w / 2, -h / 2, w, h);
            // catchlight, offset against the gaze so it behaves like a
            // reflection of a fixed light rather than a painted-on dot
            ctx.fillStyle = 'rgba(255,255,255,0.30)';
            ctx.beginPath();
            ctx.ellipse(-w * 0.22 - gaze.x * w * 0.06, -h * 0.24 - gaze.y * h * 0.05,
              w * 0.13, h * 0.1, -0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = this.color;
            if (this.glow) ctx.shadowBlur = ew * this.glow;
          }

          if (fx === 'scan') {
            // cut the sweep out rather than painting over — the eye is already solid colour
            const sx = -w / 2 + ((ft * 1.1) % 1.3 - 0.15) * w;
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillRect(sx - w * 0.06, -h, w * 0.12, h * 2);
            ctx.globalCompositeOperation = 'source-over';
          }
          if (fx === 'orbit') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath(); ctx.arc(0, 0, w * 0.28, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, w * 0.6, ft * 4, ft * 4 + 1.2); ctx.closePath(); ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        ctx.restore();

        if (fx === 'tears') {
          const ty = ((ft * 0.9 + (side === 'L' ? 0.5 : 0)) % 1);
          ctx.save(); ctx.fillStyle = this.color; ctx.globalAlpha = 1 - ty;
          const tx = x + s * w * 0.3, tyy = y + h / 2 + ty * eh * 0.9;
          roundRect(ctx, tx - ew * 0.04, tyy, ew * 0.08, ew * 0.14, [ew * 0.04, ew * 0.04, ew * 0.04, ew * 0.04]);
          ctx.fill(); ctx.restore();
        }
      };
      drawEye(this.cur.L, 'L'); drawEye(this.cur.R, 'R');

      if (needsBuffer) {
        main.save();
        main.setTransform(1, 0, 0, 1, 0, 0);
        main.drawImage(this.off, 0, 0);
        main.restore();
        main.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (this.glow) main.shadowBlur = 0;

      /* Ideas landing: three motes rising and fading above the eyes. The one
         effect in here that draws outside the eyes themselves, and the reason
         "inspired" reads as an idea rather than just wide eyes. */
      if (fx === 'spark') {
        main.save();
        main.fillStyle = this.color;
        for (let i = 0; i < 3; i++) {
          const p = ((ft * 0.75) + i * 0.33) % 1;
          const px = cx + (i - 1) * ew * 0.95 + noise(ft * 0.6 + i * 3, this.seed) * ew * 0.18;
          const py = cy - eh * 0.75 - p * eh * 0.75;
          const rr = ew * 0.055 * (1 - p * 0.45);
          main.globalAlpha = Math.sin(p * Math.PI) * 0.9;
          star(main, px, py, rr);
        }
        main.restore();
      }

      if (fx === 'zz') {
        main.save(); main.fillStyle = this.color;
        main.font = `700 ${ew * 0.28}px ui-sans-serif, system-ui, sans-serif`;
        for (let i = 0; i < 3; i++) {
          const p = ((ft * 0.5) + i * 0.33) % 1;
          main.globalAlpha = (1 - p) * 0.9;
          main.fillText('z', cx + ew * 1.3 + p * ew * 0.5 + i * ew * 0.12, cy - eh * 0.2 - p * eh * 0.9);
        }
        main.restore();
      }
      if (fx === 'glitch' && jitter) {
        for (let i = 0; i < 3; i++) {
          const yy = Math.random() * H, hh = 2 + Math.random() * H * 0.05;
          const img = main.getImageData(0, yy * dpr, W * dpr, hh * dpr);
          main.putImageData(img, (Math.random() - 0.5) * W * 0.08 * dpr, yy * dpr);
        }
      }
    }
  }

  function mixEye(a, b, t) {
    const o = cloneEye(a);
    for (const k in o) {
      if (k === 'r') for (let i = 0; i < 4; i++) o.r[i] = lerp(a.r[i], b.r[i], t);
      else if (k === 'shape') o.shape = t > 0.85 ? b.shape : a.shape;
      else o[k] = lerp(a[k], b[k], t);
    }
    return o;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const [tl, tr, br, bl] = r;
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br); ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl); ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }
  function heart(ctx, w, h) {
    const s = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.9);
    ctx.bezierCurveTo(-s * 1.3, -s * 0.1, -s * 0.7, -s * 1.1, 0, -s * 0.4);
    ctx.bezierCurveTo(s * 0.7, -s * 1.1, s * 1.3, -s * 0.1, 0, s * 0.9);
    ctx.closePath(); ctx.fill();
  }
  function cross(ctx, w, h) {
    const s = Math.min(w, h) / 2;
    ctx.lineWidth = s * 0.42; ctx.lineCap = 'round'; ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    ctx.moveTo(-s * 0.7, -s * 0.7); ctx.lineTo(s * 0.7, s * 0.7);
    ctx.moveTo(s * 0.7, -s * 0.7); ctx.lineTo(-s * 0.7, s * 0.7);
    ctx.stroke();
  }
  /* A four-pointed sparkle, not a five-pointed star: concave sides read as
     light at this size, where a polygon just reads as a blob. */
  function star(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.16, y - r * 0.16, x + r, y);
    ctx.quadraticCurveTo(x + r * 0.16, y + r * 0.16, x, y + r);
    ctx.quadraticCurveTo(x - r * 0.16, y + r * 0.16, x - r, y);
    ctx.quadraticCurveTo(x - r * 0.16, y - r * 0.16, x, y - r);
    ctx.closePath(); ctx.fill();
  }

  global.JioEyes = Eyes;
  global.JioEyes.EXPR = EXPR;
})(window);

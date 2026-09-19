/* One mascot, just eyes — no bounding box. Lives inside the thread and glides
   between slots, morphing size/position as it goes. */
(function (global) {
  'use strict';

  const CW = 64, CH = 40;
  const { lerp, Ease } = global.Motion;
  const easeOutExpo = Ease.outExpo;
  const easeInOut = Ease.inOutCubic;
  const r2 = (n) => Math.round(n * 100) / 100;
  const r3 = (n) => Math.round(n * 1000) / 1000;

  class Mascot {
    constructor(wrap, el) {
      this.wrap = wrap; this.el = el;
      this.canvas = el.querySelector('canvas');
      this.eyes = new JioEyes(this.canvas, { size: 0.5, gap: 0.5, idle: true, track: true, color: this.themeColor() });
      this.eyes.start();
      this.slot = null;
      this.mood = 'neutral';
      this.busy = false;
      this.cur = null;          // {x,y,w,h,r}
      this.from = null; this.to = null; this.t0 = 0; this.dur = 0;
      this.judgeScale = 1; this.judgeShakeX = 0; this.judgeRot = 0;
      this.hoverLift = 0; this.hoverTilt = 0;
      this._inspect = null;
      this._judging = false; this._judgeQueue = [];
      // Every written style is cached and compared before it is written.
      // Assigning el.style.width/height invalidates layout whether or not the
      // value changed, and these ran on every single frame — so the mascot
      // was forcing a layout pass sixty times a second to hold still.
      this._applied = { t: '', ct: '', w: -1, h: -1 };
      // one clock for the whole app (see js/motion.js) rather than a private
      // rAF loop per animated thing
      this.tick = this.tick.bind(this);
      global.Motion.add(this.tick);

      el.addEventListener('click', () => this.react('surprised', 900));
      this.ro = new ResizeObserver(() => this.sync());
      // observe the wrap itself too — its own size/position can shift (empty-state
      // centering settling, composer height changing) without any child firing a
      // resize, which otherwise leaves the mascot stranded at a stale measurement
      this.ro.observe(wrap);
      [...wrap.children].filter(c => c !== el).forEach(c => this.ro.observe(c));
      window.addEventListener('resize', () => this.sync());
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.sync());

      this.idleTimer = setInterval(() => {
        if (this.busy || document.hidden || this.to) return;
        const r = Math.random();
        if (r < 0.12) this.react('curious', 1400);
        else if (r < 0.18) this.react('happy', 1100);
        else if (r < 0.21) this.react('sleepy', 2400);
      }, 5000);
    }

    /* No box means the eyes must read against whatever background they float
       over — white doesn't work on a light background. Match the theme's ink. */
    themeColor() {
      return (getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#fff').trim() || '#fff';
    }
    syncTheme() { this.eyes.color = this.themeColor(); }

    measure(slot) {
      const a = slot.getBoundingClientRect(), b = this.wrap.getBoundingClientRect();
      const r = parseFloat(getComputedStyle(slot).borderRadius) || 8;
      return { x: a.left - b.left + this.wrap.scrollLeft, y: a.top - b.top + this.wrap.scrollTop, w: a.width, h: a.height, r };
    }

    /* Where the mascot actually is on screen right now, in wrap coordinates. */
    here() {
      const a = this.el.getBoundingClientRect(), b = this.wrap.getBoundingClientRect();
      return {
        x: a.left - b.left + this.wrap.scrollLeft, y: a.top - b.top + this.wrap.scrollTop,
        w: a.width, h: a.height, r: this.cur ? this.cur.r : parseFloat(getComputedStyle(this.el).borderRadius) || 10,
      };
    }

    /* Glide to a slot. Previous slot gets its static mark back. */
    moveTo(slot, animate = true) {
      if (!slot) return;
      if (this.slot && this.slot !== slot) this.slot.classList.remove('live');
      this.slot = slot; slot.classList.add('live');
      // A hidden target (display:none, or an ancestor that is) has no sensible
      // rect to fly to — measuring it collapses the mascot to a zero-size point.
      // This is the normal case at boot: the app is revealed inside a view
      // transition, which applies its mutation a frame or two later, so the
      // greeting isn't on screen yet when the first move is asked for. Keep the
      // destination and land as soon as it's real.
      if (slot.offsetParent === null) { this.want = animate; this.land(); return; }
      this.want = null;
      this.glideTo(this.measure(slot), animate);
    }

    /* The tween itself, against any rect — moveTo() measures a DOM slot and
       hands it here; inspect() computes vantage points around a message and
       does the same. Nothing below this line cares which. */
    glideTo(tgt, animate = true, durScale = 1) {
      if (!this.cur || !animate) { this.cur = tgt; this.to = null; this.apply(); return; }
      // start from the on-screen position, so a layout change mid-flight can't teleport the launch point
      const from = this.here();
      const dist = Math.hypot(tgt.x - from.x, tgt.y - from.y);
      if (dist < 1 && Math.abs(tgt.w - from.w) < 1) { this.cur = tgt; this.to = null; this.apply(); return; }
      this.cur = from; this.from = from; this.to = tgt;
      this.t0 = performance.now();
      this.dur = Math.min(900, Math.max(420, 320 + dist * 0.55)) * durScale;
      if (!this._judging) this.eyes.blink();
    }

    /* Wait for a slot that isn't on screen yet, then go. Bounded, so a slot
       that never appears (someone sitting on another view) stops costing frames;
       sync() picks it up if it shows up later. */
    land(frames = 240) {
      if (this._landing) return;
      this._landing = true;
      const step = (left) => {
        if (!this.slot || this.want === null) { this._landing = false; return; }
        if (this.slot.offsetParent !== null) {
          this._landing = false;
          const animate = this.want === true;
          this.want = null;
          this.moveTo(this.slot, animate);
          return;
        }
        if (left <= 0) { this._landing = false; return; }
        requestAnimationFrame(() => step(left - 1));
      };
      requestAnimationFrame(() => step(frames));
    }

    /* Layout shifted under us (streaming text, resize): follow without ceremony. */
    sync() {
      // mid-inspection the mascot is deliberately away from its slot; letting
      // sync() drag it back would cancel every hop the moment the thread
      // reflows (which, while a reply streams in, is constantly)
      if (this._inspect) return;
      if (!this.slot || !this.slot.isConnected || this.slot.offsetParent === null) return;
      // never got to land at all (boot happened behind a view transition)
      if (!this.cur) { this.moveTo(this.slot, false); return; }
      const tgt = this.measure(this.slot);
      if (this.to) { this.to = tgt; return; }
      if (!this.cur) { this.cur = tgt; this.apply(); return; }
      const d = Math.hypot(tgt.x - this.cur.x, tgt.y - this.cur.y);
      if (d < 0.5) return;
      if (d < 60) { this.cur = tgt; this.apply(); } else this.moveTo(this.slot);
    }

    tick(dt, now) {
      /* Inspection drives itself from here: hop when the current pause is up,
         aim the gaze every frame (the mascot is usually moving, so a gaze set
         once at arrival would slide off the message), and hover in place
         rather than sitting dead still between hops. */
      if (this._inspect) {
        const st = this._inspect;
        if (!this.to && now >= st.hopAt) this.hop(now);
        if (st.aim) this.aimAt(st.aim);
        this.hoverLift = Math.sin(now / 620) * 2.2;
        this.hoverTilt = (st.vantage ? st.vantage.tilt : 0) + Math.sin(now / 900) * 1.6;
        if (!this.to) this.apply();
      }

      if (!this.to) return;
      const p = Math.min(1, (now - this.t0) / this.dur);
      const e = easeOutExpo(p), s = easeInOut(p);
      const f = this.from, t = this.to;
      this.cur = {
        x: lerp(f.x, t.x, e), y: lerp(f.y, t.y, e),
        w: lerp(f.w, t.w, s), h: lerp(f.h, t.h, s), r: lerp(f.r, t.r, s),
      };
      // lean into the direction of travel, settle with a soft squash
      const dx = t.x - f.x, dy = t.y - f.y;
      const lean = Math.sign(dx) * Math.min(10, Math.abs(dx) * 0.04) * Math.sin(Math.PI * Math.min(1, p * 1.25));
      const lift = -Math.min(14, Math.hypot(dx, dy) * 0.06) * Math.sin(Math.PI * p);
      const squash = p > 0.7 ? 1 - 0.08 * Math.sin(Math.PI * (p - 0.7) / 0.3) : 1;
      this.apply(lean, lift, squash);
      if (p >= 1) { this.cur = t; this.to = null; this.apply(); }
    }

    /* The only place this thing touches the DOM. Two rules hold it to a
       compositor-only cost: never write a value that is already there, and
       round the sub-pixel noise off first — a transform that differs in the
       fourth decimal place is a repaint nobody can see. */
    apply(lean = 0, lift = 0, squash = 1) {
      const c = this.cur; if (!c) return;
      lift += this.hoverLift || 0;
      lean += this.hoverTilt || 0;
      const a = this._applied;

      const t = `translate3d(${r2(c.x)}px, ${r2(c.y + lift)}px, 0)`;
      if (t !== a.t) { this.el.style.transform = a.t = t; }

      // width/height are layout, so they are only written when the mascot
      // genuinely changes size — which is on arrival at a differently-sized
      // slot, not on every frame of getting there
      const w = r2(c.w), h = r2(c.h);
      if (w !== a.w) { this.el.style.width = w + 'px'; a.w = w; }
      if (h !== a.h) { this.el.style.height = h + 'px'; a.h = h; }

      const k = Math.min(c.w / CW, c.h / CH) * 0.86 * this.judgeScale;
      const ct = `translate(calc(-50% + ${r2(this.judgeShakeX)}px), -50%) rotate(${r2(lean + this.judgeRot)}deg) scale(${r3(k)}, ${r3(k * squash)})`;
      if (ct !== a.ct) { this.canvas.style.transform = a.ct = ct; }
    }

    /* A settled mood, not a passing reaction — so it is also what the room
       is tinted by (see .aura in css/app.css). react() deliberately does not
       come through here: a 900ms glance should not repaint the screen. */
    set(mood) {
      this.mood = mood;
      this.eyes.set(mood);
      document.documentElement.dataset.mood = mood;
    }
    react(mood, ms) {
      if (this.busy) return;
      const prev = this.mood;
      this.eyes.set(mood);
      clearTimeout(this._reactT);
      this._reactT = setTimeout(() => this.eyes.set(this.mood = prev), ms);
    }
    /* Working on it: focused reads as engaged/thinking, not a robotic sweep. */
    work() {
      this.busy = true;
      clearTimeout(this._reactT);
      this.set('focused');
      document.documentElement.dataset.working = '1';
    }
    /* mood, if given (the reply's own {{mood:x}} tag), holds a while — an emotion
       that snaps back instantly doesn't read as real — then eases to neutral. */
    done(ok = true, mood = null) {
      this.stopInspect();
      this.busy = false;
      delete document.documentElement.dataset.working;
      clearTimeout(this._reactT);
      if (mood) { this.set(mood); this._reactT = setTimeout(() => this.set('neutral'), 2200); }
      else { this.set('neutral'); this.react(ok ? 'happy' : 'sad', 1400); }
    }

    /* ---------- inspection ----------
       For a reply that's taking a while, jio stops sitting politely in its
       slot and goes and *looks* at what it was asked — beside the message
       or below it, gently rotated toward it, never hanging over the top.
       The gaze is aimed at the message the whole time (see aimAt below), so
       wherever it drifts to, it's visibly still reading the same thing.

       Vantage points are expressed as a fraction of the message's own box
       plus a gap, so this works the same on a one-line question and a long
       pasted one. `tilt` is a small rotation only — never a skew or a resize
       of the eyes themselves. */
    static get VANTAGE() {
      return [
        { ax: -0.04, ay: 0.42, gx: -20, gy: 0, lean: 1.00, tilt: -4, mood: 'curious' },
        { ax: 1.04, ay: 0.42, gx: 20, gy: 0, lean: 1.00, tilt: 4, mood: 'focused' },
        { ax: 0.72, ay: 1.02, gx: 0, gy: 22, lean: 1.00, tilt: 5, mood: 'curious' },
        { ax: 0.14, ay: 1.02, gx: 0, gy: 22, lean: 1.00, tilt: -5, mood: 'focused' },
      ];
    }

    inspect(target) {
      if (!target || this._inspect) return;
      const base = this.cur ? { w: this.cur.w, h: this.cur.h, r: this.cur.r } : { w: 42, h: 24, r: 8 };
      this._inspect = { el: target, base, i: -1, hopAt: 0, order: this.shuffledVantages() };
      this.busy = true;
      clearTimeout(this._reactT);
      // gaze is aimed by hand from here, so the idle wander has to stop — and
      // `track` is what lets a gaze be applied at all (see eyes.js draw()),
      // so it goes on for the duration and off again after.
      this._eyeState = { idle: this.eyes.idle, track: this.eyes.track };
      this.eyes.idle = false; this.eyes.track = true;
      this.set('curious');
    }

    shuffledVantages() {
      const v = Mascot.VANTAGE.slice();
      for (let i = v.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [v[i], v[j]] = [v[j], v[i]];
      }
      return v;
    }

    stopInspect(returnToSlot = true) {
      if (!this._inspect) return;
      this._inspect = null;
      this.hoverLift = 0; this.hoverTilt = 0;
      if (this._eyeState) { this.eyes.idle = this._eyeState.idle; this.eyes.track = this._eyeState.track; this._eyeState = null; }
      this.eyes.look(0, 0);
      if (returnToSlot && this.slot) this.moveTo(this.slot, true);
    }

    /* One hop: pick the next vantage around the message and glide there. */
    hop(now) {
      const st = this._inspect;
      const el = st.el;
      if (!el.isConnected || el.offsetParent === null) { this.stopInspect(); return; }
      st.i++;
      if (st.i >= st.order.length) { st.order = this.shuffledVantages(); st.i = 0; }
      const v = st.order[st.i];
      const b = this.wrap.getBoundingClientRect(), a = el.getBoundingClientRect();
      const r = {
        x: a.left - b.left + this.wrap.scrollLeft,
        y: a.top - b.top + this.wrap.scrollTop,
        w: a.width, h: a.height,
      };
      const w = st.base.w * v.lean, h = st.base.h * v.lean;
      const cx = r.x + v.ax * r.w + v.gx;
      const cy = r.y + v.ay * r.h + v.gy;
      st.vantage = v;
      st.aim = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      // a considered move, not a dart: inspection hops run slower than the
      // ordinary slot-to-slot glide
      this.glideTo({ x: cx - w / 2, y: cy - h / 2, w, h, r: st.base.r }, true, 1.35);
      this.eyes.set(v.mood);
      st.hopAt = now + 1500 + Math.random() * 1400;
    }

    /* Point the eyes at a spot in wrap coordinates. The divisor is a falloff:
       small offsets still read as a definite look, large ones saturate rather
       than pinning the pupils to the rim. */
    aimAt(pt) {
      if (!this.cur) return;
      const dx = pt.x - (this.cur.x + this.cur.w / 2);
      const dy = pt.y - (this.cur.y + this.cur.h / 2);
      this.eyes.look(Math.max(-1, Math.min(1, dx / 70)), Math.max(-1, Math.min(1, dy / 48)));
    }

    /* Something questionable came in: eyes go huge — an "ayo?" double-take — hold
       a beat, shrink back down, then shake it off with a disapproving head-shake.
       Runs in place, wherever the mascot currently sits. */
    judge() {
      if (this._judging) return;
      this._judging = true;
      this.busy = true;
      clearTimeout(this._reactT);
      const t0 = performance.now();
      const G = 240, H = 280, S = 220, K = 700; // grow, hold, shrink, shake
      const total = G + H + S + K;
      this.eyes.set('surprised');

      const step = (dt, now) => {
        const t = now - t0;
        if (t < G) {
          this.judgeScale = 1 + 0.9 * easeOutExpo(t / G);
        } else if (t < G + H) {
          const lp = (t - G) / H;
          this.judgeScale = 1.9 + Math.sin(lp * Math.PI * 3) * 0.03;
        } else if (t < G + H + S) {
          const p = (t - G - H) / S;
          this.judgeScale = 1.9 - 0.9 * easeOutExpo(p);
          if (p > 0.5) this.eyes.set('suspicious');
        } else if (t < total) {
          const p = (t - G - H - S) / K;
          const decay = Math.pow(1 - p, 1.7);
          this.judgeScale = 1;
          this.judgeShakeX = Math.sin(p * Math.PI * 8) * 10 * decay;
          this.judgeRot = Math.sin(p * Math.PI * 8) * 7 * decay;
          if (p > 0.05 && p < 0.09) this.eyes.set('confused');
        } else {
          this.judgeScale = 1; this.judgeShakeX = 0; this.judgeRot = 0;
          this.hoverLift = 0; this.hoverTilt = 0;
          this._inspect = null;
          this.apply();
          this._judging = false; this.busy = false;
          this.set('neutral');
          const queued = this._judgeQueue; this._judgeQueue = [];
          queued.forEach(fn => fn());
          off();
          return;
        }
        this.apply();
      };
      const off = global.Motion.add(step);
    }
    /* Run fn once any judge() reaction in progress has finished (or now, if none is). */
    afterJudge(fn) {
      if (!this._judging) { fn(); return; }
      this._judgeQueue.push(fn);
    }
  }

  global.Mascot = Mascot;
})(window);

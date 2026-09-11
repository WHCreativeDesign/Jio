/* One mascot, just eyes. Lives inside the thread and glides between slots. */
(function (global) {
  'use strict';

  const CW = 64, CH = 40;
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutExpo = (t) => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  class Mascot {
    constructor(wrap, el) {
      this.wrap = wrap; this.el = el;
      this.canvas = el.querySelector('canvas');
      this.eyes = new JioEyes(this.canvas, { size: 0.5, gap: 0.5, idle: true, track: false });
      this.eyes.start();
      this.slot = null;
      this.mood = 'neutral';
      this.busy = false;
      this.cur = null;          // {x,y,w,h,r}
      this.from = null; this.to = null; this.t0 = 0; this.dur = 0;
      this.raf = requestAnimationFrame(this.tick.bind(this));

      el.addEventListener('click', () => this.react('surprised', 900));
      this.ro = new ResizeObserver(() => this.sync());
      [...wrap.children].filter(c => c !== el).forEach(c => this.ro.observe(c));
      window.addEventListener('resize', () => this.sync());

      this.idleTimer = setInterval(() => {
        if (this.busy || document.hidden || this.to) return;
        const r = Math.random();
        if (r < 0.12) this.react('curious', 1400);
        else if (r < 0.18) this.react('happy', 1100);
        else if (r < 0.21) this.react('sleepy', 2400);
      }, 5000);
    }

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
      const tgt = this.measure(slot);
      if (!this.cur || !animate) { this.cur = tgt; this.to = null; this.apply(); return; }
      // start from the on-screen position, so a layout change mid-flight can't teleport the launch point
      const from = this.here();
      const dist = Math.hypot(tgt.x - from.x, tgt.y - from.y);
      if (dist < 1 && Math.abs(tgt.w - from.w) < 1) { this.cur = tgt; this.to = null; this.apply(); return; }
      this.cur = from; this.from = from; this.to = tgt;
      this.t0 = performance.now();
      this.dur = Math.min(900, Math.max(420, 320 + dist * 0.55));
      this.eyes.blink();
    }

    /* Layout shifted under us (streaming text, resize): follow without ceremony. */
    sync() {
      if (!this.slot || !this.slot.isConnected) return;
      const tgt = this.measure(this.slot);
      if (this.to) { this.to = tgt; return; }
      if (!this.cur) { this.cur = tgt; this.apply(); return; }
      const d = Math.hypot(tgt.x - this.cur.x, tgt.y - this.cur.y);
      if (d < 0.5) return;
      if (d < 60) { this.cur = tgt; this.apply(); } else this.moveTo(this.slot);
    }

    tick(now) {
      this.raf = requestAnimationFrame(this.tick.bind(this));
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

    apply(lean = 0, lift = 0, squash = 1) {
      const c = this.cur; if (!c) return;
      this.el.style.transform = `translate(${c.x}px, ${c.y + lift}px)`;
      this.el.style.width = c.w + 'px'; this.el.style.height = c.h + 'px';
      this.el.style.borderRadius = c.r + 'px';
      const k = Math.min(c.w / CW, c.h / CH) * 0.86;
      this.canvas.style.transform = `translate(-50%,-50%) rotate(${lean}deg) scale(${k}, ${k * squash})`;
    }

    set(mood) { this.mood = mood; this.eyes.set(mood); }
    react(mood, ms) {
      if (this.busy) return;
      const prev = this.mood;
      this.eyes.set(mood);
      clearTimeout(this._reactT);
      this._reactT = setTimeout(() => this.eyes.set(this.mood = prev), ms);
    }
    think() { this.busy = true; clearTimeout(this._reactT); this.set('thinking'); }
    done(ok = true) { this.busy = false; this.set('neutral'); this.react(ok ? 'happy' : 'sad', 1400); }
  }

  global.Mascot = Mascot;
})(window);

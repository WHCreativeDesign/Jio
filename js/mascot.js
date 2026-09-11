/* The mascot is just eyes. It hops to whatever has focus. */
(function (global) {
  'use strict';

  class Mascot {
    constructor(el) {
      this.el = el;
      this.canvas = el.querySelector('canvas');
      this.eyes = new JioEyes(this.canvas, { size: 0.5, gap: 0.5, idle: true, track: true });
      this.eyes.start();
      this.target = null;
      this.mood = 'neutral';
      this.x = window.innerWidth / 2; this.y = 120;
      this.place(this.x, this.y, false);

      window.addEventListener('pointermove', (e) => {
        const r = this.el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        this.eyes.look((e.clientX - cx) / 300, (e.clientY - cy) / 200);
      });
      window.addEventListener('resize', () => this.target && this.hopTo(this.target, false));
      window.addEventListener('scroll', () => this.target && this.hopTo(this.target, false), true);
      el.addEventListener('click', () => this.react('surprised', 900));

      this.idleTimer = setInterval(() => {
        if (this.busy || document.hidden) return;
        const r = Math.random();
        if (r < 0.15) this.react('curious', 1500);
        else if (r < 0.22) this.react('happy', 1200);
        else if (r < 0.26) this.react('sleepy', 2500);
      }, 4000);
    }

    place(x, y, animate = true) {
      this.el.classList.toggle('hop', animate);
      this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (animate) { clearTimeout(this._hopT); this._hopT = setTimeout(() => this.el.classList.remove('hop'), 500); }
    }

    /* Sit on the top-right edge of the element, tucked inside the viewport. */
    hopTo(target, animate = true) {
      if (!target || !target.isConnected) return;
      this.target = target;
      const r = target.getBoundingClientRect();
      const w = this.el.offsetWidth, h = this.el.offsetHeight;
      let x = r.right - w - 8, y = r.top - h + 6;
      if (r.width < 160) { x = r.right + 6; y = r.top + r.height / 2 - h / 2; }
      x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
      y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
      if (Math.abs(x - this.x) < 2 && Math.abs(y - this.y) < 2) return;
      const far = Math.hypot(x - this.x, y - this.y) > 40;
      this.x = x; this.y = y;
      this.place(x, y, animate && far);
      if (animate && far) this.eyes.blink();
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

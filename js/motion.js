/* jio motion — the one clock, and the physics everything animates with.

   Before this, every animated thing in the app ran its own
   requestAnimationFrame loop: the boot eyes, the auth eyes, the mascot's
   eyes, the live stage's eyes, and the mascot's own glide on top of them.
   Five loops meant five callbacks, five `performance.now()` reads and five
   independent ideas of what "now" is per frame — and none of them stopped
   when the tab went into the background.

   Everything registers here instead. One rAF, one dt, computed once and
   handed to every animator in a fixed order. The loop stops entirely when
   nothing is registered or the tab is hidden, and — the part that actually
   matters for battery — an animator that reports itself at rest is stepped
   but never asked to paint. */
(function (global) {
  'use strict';

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the clock ---------- */
  const animators = new Set();
  let raf = 0, last = 0;

  function frame(now) {
    // A hidden tab throttles rAF to roughly once a second; a backgrounded one
    // can stop it for minutes. Either way the first frame back would carry a
    // dt measured in whole seconds and teleport every spring in the app, so
    // the step is clamped to something a simulation can actually integrate.
    const dt = Math.min(0.05, (now - last) / 1000) || 0;
    last = now;
    for (const a of animators) {
      try { a(dt, now); } catch (e) { /* one bad animator must not stop the clock */ }
    }
    raf = animators.size ? requestAnimationFrame(frame) : 0;
  }

  function wake() {
    if (raf || !animators.size || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function add(fn) { animators.add(fn); wake(); return () => animators.delete(fn); }
  function remove(fn) { animators.delete(fn); }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else wake();
  });

  /* ---------- physics ----------
     Frame-rate-independent exponential decay. The naive `v += (t - v) * 0.2`
     every frame is the same easing at 60Hz and 120Hz in name only — it moves
     twice as fast on the faster display. This is the same curve expressed
     against real time, so a 120Hz monitor gets smoother motion rather than
     quicker motion. */
  const damp = (v, t, lambda, dt) => t + (v - t) * Math.exp(-lambda * dt);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* A second-order spring, integrated semi-implicitly with a fixed sub-step.
     Springs are what make motion read as a physical object rather than a
     played-back curve: they carry velocity, so an interruption mid-flight
     redirects instead of restarting, and a little overshoot on arrival is
     what separates "alive" from "tweened".

     `stiffness` is how hard it pulls toward the target, `damping` how much of
     that it loses to friction. damping = 2*sqrt(stiffness) is critical — the
     fastest approach with no overshoot at all; below that it bounces. */
  class Spring {
    constructor(value, opts = {}) {
      this.v = value; this.target = value; this.vel = 0;
      this.stiffness = opts.stiffness ?? 170;
      this.damping = opts.damping ?? 26;
      this.precision = opts.precision ?? 0.0005;
    }
    set(target) { this.target = target; return this; }
    /* Teleport: no travel, no velocity left over from wherever it was going. */
    jump(value) { this.v = this.target = value; this.vel = 0; return this; }
    get settled() {
      return Math.abs(this.v - this.target) < this.precision && Math.abs(this.vel) < this.precision;
    }
    step(dt) {
      if (this.settled) { this.v = this.target; this.vel = 0; return this.v; }
      // Sub-stepping keeps a stiff spring stable across a long frame: one
      // 50ms step through a k=400 spring diverges, five 10ms steps don't.
      const steps = Math.min(8, Math.ceil(dt / 0.008)) || 1;
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = (this.target - this.v) * this.stiffness - this.vel * this.damping;
        this.vel += a * h;
        this.v += this.vel * h;
      }
      return this.v;
    }
  }

  /* Curves. Named rather than inlined so the same motion signature is reused
     across the app instead of every caller inventing its own ease. */
  const Ease = {
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    /* Overshoots past 1 and settles back — for something arriving with weight. */
    outBack: (t, s = 1.7) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
    /* Anticipation: dips below 0 before committing, the way a body loads
       before it moves. */
    inBack: (t, s = 1.7) => (s + 1) * t * t * t - s * t * t,
  };

  /* Deterministic value noise — for idle drift and micro-motion that should
     wander rather than oscillate. Math.random() per frame is white noise and
     reads as jitter; this is smooth, so it reads as life. */
  function noise(t, seed = 0) {
    const i = Math.floor(t), f = t - i;
    const h = (n) => {
      const x = Math.sin((n + seed * 374.761) * 127.1) * 43758.5453;
      return x - Math.floor(x);
    };
    const u = f * f * (3 - 2 * f);           // smoothstep between integer samples
    return lerp(h(i), h(i + 1), u) * 2 - 1;  // -1..1
  }

  global.Motion = { add, remove, wake, damp, lerp, clamp, noise, Spring, Ease, reduced };
})(window);

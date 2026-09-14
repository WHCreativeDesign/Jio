/* Thought particles: little symbols that come off the eyes while jio thinks.
   Mounted on the mascot itself (see Mascot.think), so wherever the eyes go —
   including off inspecting a message — the symbols go with them.

   Three kinds, all small and all emitted from just beside the eyes rather
   than scattered across the page:
     · maths — real fragments (∫, ∑, θ, x², f(x)), the loudest of the three;
     · words — connective tissue ("if", "therefore"), rarer and fainter, so
       the stream reads as language as well as arithmetic;
     · synapses — a two-or-three node fleck with a signal running between
       them, the neuron idea at the scale of a spark rather than a mesh.

   Everything drifts up and outward from the eyes and fades, so the effect
   reads as thought leaving the head, not as decoration sitting behind it. */
(function (global) {
  'use strict';

  const GLYPHS = [
    '∫', '∑', '√', 'π', '∞', 'Δ', 'θ', 'λ', 'σ', '∂', '≈', '≠', '≤', '∴', '∇', 'φ', '±',
    'x²', 'aⁿ', 'f(x)', 'n!', '½', 'dx', 'Σn',
  ];
  const WORDS = ['if', 'then', 'so', 'but', 'therefore', 'given', 'maybe', 'hence', 'unless'];

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[(Math.random() * a.length) | 0];

  class ThinkFX {
    /* host: the mascot element. The canvas is centred on it, larger than it,
       pointer-transparent and absolutely positioned — so it adds no layout
       and simply rides along with whatever transform the mascot is under. */
    constructor(host) {
      this.host = host;
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'think-fx';
      this.canvas.setAttribute('aria-hidden', 'true');
      host.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');

      this.parts = [];
      this.t = 0; this.last = 0; this._raf = 0;
      this.spawnIn = 0.15;
      this.intensity = 0;          // eases in and out, so it never pops
      this.target = 1;

      this.readColors();
      this.resize();
      this.loop = this.loop.bind(this);
      this._onResize = () => this.resize();
      global.addEventListener('resize', this._onResize);
      if (this.reduced) { this.intensity = 0.7; this.draw(); } else this.start();
    }

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
      this.cFg = v('--fg-3', '#8d8b83');
      this.cHi = v('--fg-2', '#c2c0b6');
      this.cAcc = v('--accent', '#6c8cff');
    }

    resize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dpr = dpr; this.W = w; this.H = h;
    }

    start() { if (!this._raf) { this.last = performance.now(); this._raf = requestAnimationFrame(this.loop); } }
    stop() { cancelAnimationFrame(this._raf); this._raf = 0; }

    /* Fade out, then tear down — so the last few symbols finish their drift
       instead of blinking out the instant the first token lands. */
    destroy() {
      this.dying = true;
      this.target = 0;
      global.removeEventListener('resize', this._onResize);
      setTimeout(() => { this.stop(); this.canvas.remove(); }, 600);
    }

    loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now; this.t += dt;
      if (!document.hidden) { this.update(dt); this.draw(); }
      this._raf = requestAnimationFrame(this.loop);
    }

    /* Spawn beside the eyes: a side is picked, and the particle starts at the
       edge of the eye cluster rather than its centre, so nothing ever appears
       on top of the eyes themselves. */
    spawn() {
      const side = Math.random() < 0.5 ? -1 : 1;
      const r = Math.random();
      const kind = r < 0.16 ? 'word' : r < 0.34 ? 'syn' : 'math';
      const x = this.W / 2 + side * rand(15, 27);
      const y = this.H / 2 + rand(-8, 6);
      const p = {
        kind, x, y,
        vx: side * rand(4, 15), vy: rand(-15, -26),
        rot: rand(-0.35, 0.35), vr: rand(-0.5, 0.5),
        life: 0, ttl: rand(1.5, 2.3),
      };
      if (kind === 'word') { p.text = pick(WORDS); p.size = rand(8, 9.5); }
      else if (kind === 'math') { p.text = pick(GLYPHS); p.size = rand(9.5, 14); }
      else {
        // a little constellation of 2-3 nodes with a signal crossing it
        p.n = Array.from({ length: 2 + ((Math.random() * 2) | 0) }, () => ({ x: rand(-7, 7), y: rand(-6, 6) }));
        p.sig = 0;
      }
      this.parts.push(p);
    }

    update(dt) {
      this.intensity += (this.target - this.intensity) * (1 - Math.exp(-dt * 4));
      this.spawnIn -= dt;
      if (!this.dying && this.spawnIn <= 0) { this.spawnIn = rand(0.16, 0.42); this.spawn(); }
      for (const p of this.parts) {
        p.life += dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vy *= 1 - dt * 0.5;        // rises, slows, hangs
        p.vx *= 1 - dt * 0.6;
        p.rot += p.vr * dt;
        if (p.kind === 'syn') p.sig = (p.sig + dt * 1.5) % 1;
      }
      this.parts = this.parts.filter((p) => p.life < p.ttl);
    }

    draw() {
      const { ctx, W, H, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const body = getComputedStyle(document.body).fontFamily;

      for (const p of this.parts) {
        const k = p.life / p.ttl;
        // in fast, out slow
        const fade = Math.min(1, k / 0.18) * Math.min(1, (1 - k) / 0.45) * this.intensity;
        if (fade <= 0) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);

        if (p.kind === 'syn') {
          // edges
          ctx.globalAlpha = fade * 0.35;
          ctx.strokeStyle = this.cFg; ctx.lineWidth = 1;
          ctx.beginPath();
          p.n.forEach((n, i) => (i ? ctx.lineTo(n.x, n.y) : ctx.moveTo(n.x, n.y)));
          ctx.stroke();
          // nodes
          ctx.globalAlpha = fade * 0.65;
          ctx.fillStyle = this.cFg;
          for (const n of p.n) { ctx.beginPath(); ctx.arc(n.x, n.y, 1.5, 0, 7); ctx.fill(); }
          // the signal, sliding along the chain
          const seg = (p.n.length - 1) * p.sig;
          const i = Math.min(p.n.length - 2, seg | 0), f = seg - i;
          const a = p.n[i], b2 = p.n[i + 1];
          if (a && b2) {
            ctx.globalAlpha = fade;
            ctx.fillStyle = this.cAcc;
            ctx.beginPath(); ctx.arc(a.x + (b2.x - a.x) * f, a.y + (b2.y - a.y) * f, 1.9, 0, 7); ctx.fill();
          }
        } else {
          ctx.globalAlpha = fade * (p.kind === 'word' ? 0.5 : 0.72);
          ctx.fillStyle = p.kind === 'word' ? this.cFg : this.cHi;
          ctx.font = p.kind === 'word'
            ? `italic 500 ${p.size}px ${body}`
            : `${p.size}px "KaTeX_Math", Cambria, Georgia, serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(p.text, 0, 0);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  global.ThinkFX = ThinkFX;
})(window);

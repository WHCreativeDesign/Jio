/* JIO eye engine — geometric rounded-rect eyes in the Vector / Cozmo / EMO lineage. */
(function (global) {
  'use strict';

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
    thinking:   both({ h: 0.8, topIn: 0.25, topOut: 0.25, dx: 0.35, dy: -0.3, r: [0.5, 0.5, 0.5, 0.5] }, 'ponder'),
    focused:    both({ h: 0.55, r: [0.25, 0.25, 0.25, 0.25], w: 1.1 }),
    bored:      both({ h: 0.55, topIn: 0.4, topOut: 0.4, r: [0.15, 0.15, 0.5, 0.5], dy: 0.1 }, 'sigh'),
    smirk:      E({ h: 0.7, topIn: 0.15, topOut: 0.3, r: [0.4, 0.4, 0.4, 0.4] }, { h: 0.8, botIn: 0.5, botOut: 0.3, r: [0.9, 0.9, 0.2, 0.2] }),
    proud:      both({ h: 0.7, topIn: 0.3, topOut: 0.3, botIn: 0.2, botOut: 0.2, r: [0.3, 0.3, 0.6, 0.6], dy: -0.05 }),
    dizzy:      both({ w: 0.95, h: 0.95, r: [0.9, 0.9, 0.9, 0.9] }, 'spin'),
    dead:       both({ shape: 2, w: 0.95, h: 0.95 }),
    glitch:     both({}, 'glitch'),
    scanning:   both({ shape: 3, h: 0.22, w: 1.15, r: [0.5, 0.5, 0.5, 0.5] }, 'scan'),
    loading:    both({ w: 0.8, h: 0.8, r: [1, 1, 1, 1] }, 'orbit'),
    blink:      both({ h: 0.06, w: 1.06, shape: 3 }),
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function lerpEye(cur, tgt, t) {
    for (const k in cur) {
      if (k === 'r') for (let i = 0; i < 4; i++) cur.r[i] = lerp(cur.r[i], tgt.r[i], t);
      else if (k === 'shape') cur.shape = tgt.shape;
      else cur[k] = lerp(cur[k], tgt[k], t);
    }
  }
  const cloneEye = (e) => ({ ...e, r: [...e.r] });

  class Eyes {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.color = opts.color || '#ffffff';
      this.bg = opts.bg || null;
      this.speed = opts.speed || 14;
      this.gap = opts.gap || 0.55;         // gap between eyes, as fraction of eye width
      this.size = opts.size || 0.34;       // eye width as fraction of canvas height
      this.autoBlink = opts.autoBlink !== undefined ? opts.autoBlink : true;
      this.idle = !!opts.idle;
      this.track = opts.track !== undefined ? opts.track : true;
      this.cur = { L: cloneEye(BASE), R: cloneEye(BASE) };
      this.name = 'neutral';
      this.expr = EXPR.neutral;
      this.gaze = { x: 0, y: 0 }; this.gazeT = { x: 0, y: 0 };
      this.blinkT = -1; this.nextBlink = 2 + Math.random() * 3;
      this.idleT = 0; this.t = 0; this.last = 0;
      this.shapeFade = 1;
      this.onFrame = null;
      this._raf = 0;
      this.resize();
      this.loop = this.loop.bind(this);
    }

    resize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const w = this.c.clientWidth || this.c.width, h = this.c.clientHeight || this.c.height;
      this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
      this.dpr = dpr; this.W = w; this.H = h;
    }

    set(name) {
      if (!EXPR[name]) return;
      this.name = name;
      this.expr = EXPR[name];
      this.fxStart = this.t;
    }
    list() { return Object.keys(EXPR).filter(k => k !== 'blink'); }
    blink() { if (this.blinkT < 0) this.blinkT = 0; }
    look(nx, ny) { this.gazeT.x = clamp(nx, -1, 1); this.gazeT.y = clamp(ny, -1, 1); }
    start() { if (!this._raf) { this.last = performance.now(); this._raf = requestAnimationFrame(this.loop); } }
    stop() { cancelAnimationFrame(this._raf); this._raf = 0; }

    loop(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
      this.update(dt); this.draw();
      if (this.onFrame) this.onFrame(this);
      this._raf = requestAnimationFrame(this.loop);
    }

    update(dt) {
      // blink timer
      if (this.autoBlink && this.blinkT < 0 && this.name !== 'sleeping' && this.name !== 'dead') {
        this.nextBlink -= dt;
        if (this.nextBlink <= 0) { this.blinkT = 0; this.nextBlink = 2.5 + Math.random() * 4; }
      }
      if (this.blinkT >= 0) { this.blinkT += dt; if (this.blinkT > 0.22) this.blinkT = -1; }

      // idle wander
      if (this.idle) {
        this.idleT -= dt;
        if (this.idleT <= 0) { this.idleT = 1 + Math.random() * 2.5; this.gazeT = { x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.5 }; }
      }
      const gk = 1 - Math.exp(-dt * 10);
      this.gaze.x = lerp(this.gaze.x, this.gazeT.x, gk);
      this.gaze.y = lerp(this.gaze.y, this.gazeT.y, gk);

      const k = 1 - Math.exp(-dt * this.speed);
      let tgt = this.expr;
      if (this.blinkT >= 0) {
        const p = this.blinkT / 0.22, closed = p < 0.5 ? p * 2 : (1 - p) * 2;
        tgt = { L: mixEye(this.expr.L, EXPR.blink.L, easeIn(closed)), R: mixEye(this.expr.R, EXPR.blink.R, easeIn(closed)) };
      }
      lerpEye(this.cur.L, tgt.L, k); lerpEye(this.cur.R, tgt.R, k);
    }

    draw() {
      const { ctx, W, H, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (this.bg) { ctx.fillStyle = this.bg; ctx.fillRect(0, 0, W, H); }
      if (!this.off || this.off.width !== this.c.width || this.off.height !== this.c.height) {
        this.off = document.createElement('canvas');
        this.off.width = this.c.width; this.off.height = this.c.height;
      }
      const oc = this.off.getContext('2d');
      oc.setTransform(dpr, 0, 0, dpr, 0, 0);
      oc.clearRect(0, 0, W, H);

      const ew = H * this.size, eh = ew * 1.15;
      const gap = ew * this.gap;
      const cx = W / 2, cy = H / 2;
      const fx = this.expr.fx, ft = this.t - (this.fxStart || 0);
      let gx = 0, gy = 0, grot = 0, gscale = 1, jitter = 0;

      if (fx === 'bounce') gy = -Math.abs(Math.sin(ft * 9)) * eh * 0.12;
      if (fx === 'pulse') gscale = 1 + Math.sin(ft * 6) * 0.05;
      if (fx === 'beat') gscale = 1 + Math.max(0, Math.sin(ft * 7)) ** 6 * 0.18;
      if (fx === 'shake') gx = Math.sin(ft * 60) * ew * 0.03;
      if (fx === 'tremble') { gx = Math.sin(ft * 45) * ew * 0.015; gy = Math.cos(ft * 38) * eh * 0.012; }
      if (fx === 'drift') gy = Math.sin(ft * 1.2) * eh * 0.05;
      if (fx === 'tilt') grot = Math.sin(ft * 1.5) * 6;
      if (fx === 'ponder') gx = Math.sin(ft * 0.8) * ew * 0.08;
      if (fx === 'sigh') gy = Math.sin(ft * 0.9) * eh * 0.04;
      if (fx === 'glitch') jitter = Math.random() < 0.12 ? 1 : 0;

      const gaze = this.track || this.idle ? this.gaze : { x: 0, y: 0 };
      const look = { x: gaze.x * ew * 0.35, y: gaze.y * eh * 0.28 };
      const sideSquash = 1 - Math.abs(gaze.x) * 0.12;

      const drawEye = (p, side) => {
        const ctx = oc;
        const s = side === 'L' ? -1 : 1;
        // parallax: eye nearer the gaze direction grows slightly
        const par = 1 + gaze.x * s * 0.06;
        const w = ew * p.w * gscale * par * sideSquash, h = eh * p.h * gscale * par;
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
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.off, 0, 0);
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (fx === 'zz') {
        ctx.save(); ctx.fillStyle = this.color;
        ctx.font = `700 ${ew * 0.28}px ui-sans-serif, system-ui, sans-serif`;
        for (let i = 0; i < 3; i++) {
          const p = ((ft * 0.5) + i * 0.33) % 1;
          ctx.globalAlpha = (1 - p) * 0.9;
          ctx.fillText('z', cx + ew * 1.3 + p * ew * 0.5 + i * ew * 0.12, cy - eh * 0.2 - p * eh * 0.9);
        }
        ctx.restore();
      }
      if (fx === 'glitch' && jitter) {
        const rows = 3;
        for (let i = 0; i < rows; i++) {
          const yy = Math.random() * H, hh = 2 + Math.random() * H * 0.05;
          const img = ctx.getImageData(0, yy * dpr, W * dpr, hh * dpr);
          ctx.putImageData(img, (Math.random() - 0.5) * W * 0.08 * dpr, yy * dpr);
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
  const easeIn = t => t * t;

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

  global.JioEyes = Eyes;
  global.JioEyes.EXPR = EXPR;
})(window);

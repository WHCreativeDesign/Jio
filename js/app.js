(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');

  /* ---------- lab ---------- */
  let eyes, booted = false;
  const KEYS = '1234567890qwertyuiopasdfghjkl';
  const DESC = {
    neutral: 'resting face', happy: 'lower lids up, arc top', laugh: 'happy + bounce', excited: 'wide + pulse', love: 'hearts, beat',
    sad: 'inner brow drop', cry: 'sad + tears', angry: 'outer brow drop', rage: 'angry + shake', surprised: 'big round',
    scared: 'small + tremble', sleepy: 'half-lid drift', sleeping: 'closed + zz', wink: 'one shut, one happy', suspicious: 'narrow slit',
    confused: 'asymmetric', curious: 'one big, head tilt', thinking: 'look up-side', focused: 'flat wide', bored: 'heavy lids',
    smirk: 'half smile', proud: 'squint up', dizzy: 'spin', dead: 'x x', glitch: 'signal loss', scanning: 'bar + sweep', loading: 'orbit ring'
  };

  function boot() {
    if (booted) return; booted = true;
    const canvas = $('#eyes');
    eyes = new JioEyes(canvas, { size: 0.36, gap: 0.5 });
    eyes.start();
    window.addEventListener('resize', () => eyes.resize());

    const grid = $('#grid'), label = $('#stage-label');
    const names = eyes.list();
    names.forEach((n, i) => {
      const b = document.createElement('button');
      b.className = 'card'; b.dataset.n = n;
      b.innerHTML = `<canvas width="120" height="60"></canvas><div class="card-name"><kbd>${KEYS[i] || ''}</kbd>${n}</div><div class="card-desc">${DESC[n] || ''}</div>`;
      b.addEventListener('click', () => pick(n));
      grid.appendChild(b);
      const mini = new JioEyes(b.querySelector('canvas'), { size: 0.55, gap: 0.45, track: false, autoBlink: false });
      mini.set(n); mini.start();
    });

    function pick(n) {
      eyes.set(n);
      Tween.run(() => {
        label.textContent = n;
        [...grid.children].forEach(c => c.classList.toggle('on', c.dataset.n === n));
      });
    }
    pick('neutral');

    // cursor tracking
    const stage = $('#stage');
    window.addEventListener('pointermove', (e) => {
      const r = stage.getBoundingClientRect();
      const nx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2));
      const ny = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2));
      if (eyes.track) eyes.look(nx, ny);
    });
    stage.addEventListener('click', () => { pick('surprised'); setTimeout(() => pick('neutral'), 900); });

    $('#track').addEventListener('change', (e) => { eyes.track = e.target.checked; if (!eyes.track) eyes.look(0, 0); });
    $('#autoblink').addEventListener('change', (e) => eyes.autoBlink = e.target.checked);
    $('#idle').addEventListener('change', (e) => { eyes.idle = e.target.checked; if (!eyes.idle) eyes.look(0, 0); });

    let tour = null;
    $('#tour').addEventListener('click', (e) => {
      if (tour) { clearInterval(tour); tour = null; e.target.textContent = 'play tour'; return; }
      let i = 0; e.target.textContent = 'stop tour';
      tour = setInterval(() => { pick(names[i % names.length]); i++; }, 1800);
    });

    document.addEventListener('keydown', (e) => {
      if (app.hidden) return;
      if (e.key === ' ') { e.preventDefault(); eyes.blink(); return; }
      const i = KEYS.indexOf(e.key.toLowerCase());
      if (i >= 0 && names[i]) pick(names[i]);
    });
  }


  boot();
})();

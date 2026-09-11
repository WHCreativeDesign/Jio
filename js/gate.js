/* Shared PIN gate. Expects #gate, #gate-eyes, #pin-dots, #keypad, #pin-hidden in the DOM. */
(function (global) {
  'use strict';
  const PIN = '0529';
  const KEY = 'jio.unlocked';
  const $ = (s) => document.querySelector(s);

  function init(onUnlock) {
    const gate = $('#gate');
    const eyes = new JioEyes($('#gate-eyes'), { size: 0.5, gap: 0.5, idle: true, track: false });
    eyes.start();

    let entered = '';
    const dots = [...$('#pin-dots').children];
    const hidden = $('#pin-hidden');
    const card = gate.querySelector('.gate-card');

    const renderDots = () => dots.forEach((d, i) => d.classList.toggle('on', i < entered.length));
    function press(k) {
      if (k === 'del') { entered = entered.slice(0, -1); eyes.set('neutral'); }
      else if (k === 'ok') { check(); return; }
      else if (entered.length < 4) { entered += k; eyes.set(entered.length === 4 ? 'excited' : 'curious'); }
      renderDots();
      if (entered.length === 4) setTimeout(check, 180);
    }
    function check() {
      if (entered === PIN) {
        eyes.set('happy');
        try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
        setTimeout(unlock, 450);
      } else {
        eyes.set(entered.length ? 'angry' : 'confused');
        card.classList.add('shake');
        setTimeout(() => { card.classList.remove('shake'); entered = ''; renderDots(); eyes.set('neutral'); }, 500);
      }
    }
    function unlock() { gate.hidden = true; eyes.stop(); onUnlock(); }

    $('#keypad').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) press(b.dataset.k); });
    hidden.addEventListener('input', () => { entered = hidden.value.replace(/\D/g, '').slice(0, 4); hidden.value = ''; renderDots(); if (entered.length === 4) setTimeout(check, 180); });
    document.addEventListener('keydown', (e) => {
      if (gate.hidden) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    });

    let unlocked = false;
    try { unlocked = sessionStorage.getItem(KEY) === '1'; } catch (e) {}
    if (unlocked) unlock();
  }

  function lock() {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  }

  global.JioGate = { init, lock };
})(window);

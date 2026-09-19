/* Ask — jio's confirmation layer.

   Everything in this app that destroys something used to do it on the first
   click: a chat, every chat at once, a memory jio had written, a donated key,
   the session itself. None of them are undoable, none of them asked, and the
   delete buttons sit a few pixels from the thing you were actually aiming at.

   So nothing irreversible happens here without a question first, and the
   question is not a browser confirm() — it is jio asking, with its own face
   on it, in its own voice. That is the point: a system dialog is the app
   interrupting you, and a character asking is the app talking to you. Same
   guard rail, completely different feeling.

   Ask.confirm(...)  -> Promise<boolean>, resolved by the choice
   Ask.toast(...)    -> a quiet line that says what just happened

   Both are keyboard-complete (Enter confirms, Escape cancels), focus-trapped,
   and hand focus back to whatever opened them. */
(function (global) {
  'use strict';

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ink = () => (getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#fff').trim() || '#fff';

  let openDialog = null;        // one at a time; a second request waits its turn
  let chain = Promise.resolve();

  /* ---------- confirm ---------- */
  function confirm(opts = {}) {
    // Serialised rather than stacked: two confirmations on screen at once is
    // never what anyone meant, and the second would steal the first's focus.
    const run = () => present(opts);
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  function present(opts) {
    const {
      title = 'Are you sure?',
      body = '',
      confirm: yes = 'Confirm',
      cancel: no = 'Cancel',
      danger = false,
      mood = danger ? 'suspicious' : 'curious',
    } = opts;

    return new Promise((resolve) => {
      const opener = document.activeElement;

      const scrim = document.createElement('div');
      scrim.className = 'ask-scrim';

      const box = document.createElement('div');
      box.className = 'ask' + (danger ? ' ask-danger' : '');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');

      const face = document.createElement('div');
      face.className = 'ask-face';
      const canvas = document.createElement('canvas');
      canvas.width = 180; canvas.height = 96;
      canvas.setAttribute('aria-hidden', 'true');
      face.appendChild(canvas);

      const h = document.createElement('h2');
      h.className = 'ask-title';
      h.id = 'ask-title-' + Math.random().toString(36).slice(2, 8);
      h.textContent = title;
      box.setAttribute('aria-labelledby', h.id);

      const p = document.createElement('p');
      p.className = 'ask-body';
      p.textContent = body;
      if (!body) p.hidden = true;

      const actions = document.createElement('div');
      actions.className = 'ask-actions';
      const bNo = document.createElement('button');
      bNo.type = 'button'; bNo.className = 'ask-btn ask-no'; bNo.textContent = no;
      const bYes = document.createElement('button');
      bYes.type = 'button'; bYes.className = 'ask-btn ask-yes'; bYes.textContent = yes;
      actions.append(bNo, bYes);

      box.append(face, h, p, actions);
      scrim.appendChild(box);
      document.body.appendChild(scrim);

      // jio looks at you while it waits for the answer
      let eyes = null;
      if (global.JioEyes) {
        eyes = new global.JioEyes(canvas, {
          size: 0.44, gap: 0.5, idle: false, track: true, alive: true, color: ink(),
        });
        eyes.set(mood);
        eyes.start();
      }

      /* The eyes follow the pointer across the dialog — so the thing asking
         is visibly paying attention to where your hand is going. The face's
         box is measured once, not per event: a dialog does not move, and
         getBoundingClientRect() inside a pointermove handler is a forced
         layout on every one of the hundreds a fast mouse fires. */
      // Measured after the entrance animation has landed, not before it: the
      // dialog spends its first 340ms scaled and offset, and a box captured
      // then would aim every look at where the dialog used to be.
      let faceBox = null;
      const remeasure = () => { faceBox = canvas.getBoundingClientRect(); };
      box.addEventListener('animationend', remeasure);
      addEventListener('resize', remeasure);
      scrim.addEventListener('pointermove', (e) => {
        if (!eyes) return;
        if (!faceBox) remeasure();
        eyes.look(
          (e.clientX - (faceBox.left + faceBox.width / 2)) / (faceBox.width * 1.6),
          (e.clientY - (faceBox.top + faceBox.height / 2)) / (faceBox.height * 2.2),
        );
      }, { passive: true });

      // a glance at whichever answer you're hovering — jio has an opinion
      bYes.addEventListener('pointerenter', () => eyes?.set(danger ? 'focused' : 'happy'));
      bNo.addEventListener('pointerenter', () => eyes?.set('curious'));
      actions.addEventListener('pointerleave', () => eyes?.set(mood));

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        eyes?.set(value ? (danger ? 'determined' : 'happy') : 'neutral');
        scrim.classList.add('ask-out');
        cleanupKeys();
        removeEventListener('resize', remeasure);
        openDialog = null;
        const close = () => {
          eyes?.destroy();
          scrim.remove();
          // focus goes back where it came from, unless that element is gone
          // (deleting a chat removes the very button that asked)
          if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
          else document.getElementById('input')?.focus();
          resolve(value);
        };
        if (reduced()) close();
        else setTimeout(close, 180);
      };

      bYes.addEventListener('click', () => finish(true));
      bNo.addEventListener('click', () => finish(false));
      // a click on the backdrop is a cancel; a click inside is not
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) finish(false); });

      /* Focus trap. Capture phase on the document, so it holds even against
         anything else in the app listening for the same keys. */
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
        if (e.key === 'Enter') {
          // Enter anywhere in the dialog takes the highlighted action, except
          // when the cancel button itself is focused — then it cancels.
          e.preventDefault(); e.stopPropagation();
          finish(document.activeElement !== bNo);
          return;
        }
        if (e.key !== 'Tab') return;
        const focusable = [bNo, bYes];
        const i = focusable.indexOf(document.activeElement);
        e.preventDefault();
        const next = e.shiftKey
          ? focusable[(i <= 0 ? focusable.length : i) - 1]
          : focusable[(i + 1) % focusable.length];
        next.focus();
      };
      document.addEventListener('keydown', onKey, true);
      const cleanupKeys = () => document.removeEventListener('keydown', onKey, true);

      openDialog = { finish };
      // Destructive dialogs open on Cancel, not on the destructive action:
      // a reflexive Enter should never be the thing that deletes something.
      (danger ? bNo : bYes).focus();
    });
  }

  /* ---------- toast ----------
     What confirmation buys you on the other side: having said yes, you get a
     one-line receipt instead of silence. Stacks upward, oldest at the top,
     and never steals focus. */
  const HOLD = 2600;
  let toastRail = null;

  function toast(text, opts = {}) {
    const { tone = '' } = opts;
    if (!toastRail) {
      toastRail = document.createElement('div');
      toastRail.className = 'toast-rail';
      toastRail.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastRail);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ' toast-' + tone : '');
    el.textContent = text;
    toastRail.appendChild(el);
    // more than a few at once is noise, not feedback
    while (toastRail.children.length > 3) toastRail.firstChild.remove();
    const go = () => {
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), reduced() ? 0 : 240);
    };
    const t = setTimeout(go, HOLD);
    el.addEventListener('click', () => { clearTimeout(t); go(); });
    return el;
  }

  global.Ask = { confirm, toast, get open() { return !!openDialog; } };
})(window);

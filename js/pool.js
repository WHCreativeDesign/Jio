/* Key pool. Local keys are real (stored in this browser). Community rows are preview placeholders until a backend exists. */
(function (global) {
  'use strict';
  const STORE = 'jio.keys';

  const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch (e) { return []; } };
  const save = (keys) => { try { localStorage.setItem(STORE, JSON.stringify(keys)); } catch (e) {} };

  const mask = (k) => k.slice(0, 7) + '…' + k.slice(-4);
  const valid = (k) => /^gsk_[A-Za-z0-9]{20,}$/.test(k.trim());

  function add(key, label) {
    key = key.trim();
    if (!valid(key)) throw new Error('that does not look like a groq key (gsk_…)');
    const keys = load();
    if (keys.some(k => k.key === key)) throw new Error('already in your pool');
    keys.push({ id: Math.random().toString(36).slice(2, 10), key, label: label.trim() || 'my key', added: Date.now(), uses: 0, status: 'ok', lastError: '' });
    save(keys);
  }
  function remove(id) { save(load().filter(k => k.id !== id)); }

  let cursor = 0;
  function pick() {
    const keys = load().filter(k => k.status !== 'dead');
    if (!keys.length) return null;
    const k = keys[cursor++ % keys.length];
    return k;
  }
  function report(id, ok, err) {
    const keys = load();
    const k = keys.find(k => k.id === id); if (!k) return;
    if (ok) { k.uses++; k.status = 'ok'; k.lastError = ''; }
    else {
      k.lastError = err?.message || String(err);
      if (err?.status === 401 || err?.status === 403) k.status = 'dead';
      else if (err?.status === 429) k.status = 'cooling';
    }
    save(keys);
  }

  // Placeholder community pool — replaced by a real shared pool once a backend lands.
  const COMMUNITY = [
    { donor: 'wes', masked: 'gsk_7Yq…k2Pd', reqs: 1284, status: 'ok', region: 'us' },
    { donor: 'anon', masked: 'gsk_Ct1…9mQa', reqs: 862, status: 'ok', region: 'eu' },
    { donor: 'mira.dev', masked: 'gsk_Bz0…x4Lr', reqs: 411, status: 'cooling', region: 'us' },
    { donor: 'anon', masked: 'gsk_Hk8…v7Ne', reqs: 3390, status: 'ok', region: 'apac' },
    { donor: 'tobi', masked: 'gsk_Qw3…d1Sf', reqs: 97, status: 'dead', region: 'eu' },
  ];

  global.Pool = { load, add, remove, pick, report, mask, valid, COMMUNITY };
})(window);

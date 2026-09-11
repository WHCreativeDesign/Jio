/* Supabase: auth (email + password, no 2FA) and the data layer. */
(function (global) {
  'use strict';

  const URL = 'https://rgaanykfytfnxksxaiez.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_rMfFflm5PTftAmsaE2sbwg_qXsing-e';

  const db = global.supabase.createClient(URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  let user = null;
  const listeners = new Set();
  db.auth.onAuthStateChange((_e, session) => {
    user = session?.user || null;
    listeners.forEach(fn => fn(user));
  });

  const nice = (err) => {
    const m = (err?.message || String(err)).toLowerCase();
    if (m.includes('invalid login')) return 'wrong email or password';
    if (m.includes('already registered') || m.includes('already been registered')) return 'that email already has an account — sign in instead';
    if (m.includes('password should be')) return 'password needs at least 6 characters';
    if (m.includes('invalid email') || m.includes('unable to validate email')) return 'that email does not look right';
    if (m.includes('email not confirmed')) return 'confirm your email first — check your inbox';
    return err?.message || 'something went wrong';
  };

  /* Races a promise against a plain timeout. A hung network call or an internal
     supabase-js deadlock must never leave the app stuck loading forever. */
  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  const Auth = {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async restore() {
      try {
        const { data } = await withTimeout(db.auth.getSession(), 8000, 'getSession');
        user = data.session?.user || null;
      } catch (e) {
        // could not confirm a session in time — proceed logged out rather than hang
        user = null;
      }
      return user;
    },
    user: () => user,
    handle: () => (user?.user_metadata?.handle) || user?.email?.split('@')[0] || 'friend',
    async signIn(email, password) {
      const { data, error } = await withTimeout(
        db.auth.signInWithPassword({ email: email.trim(), password }), 15000, 'sign in');
      if (error) throw new Error(nice(error));
      return data.user;
    },
    async signUp(email, password) {
      email = email.trim();
      const handle = email.split('@')[0];
      const { data, error } = await withTimeout(
        db.auth.signUp({ email, password, options: { data: { handle } } }), 15000, 'sign up');
      if (error) throw new Error(nice(error));
      // no session means the project still requires email confirmation
      if (!data.session) { const e = new Error('account made — confirm your email, then sign in'); e.pending = true; throw e; }
      return data.user;
    },
    signOut: () => db.auth.signOut(),
  };

  /* ---------- chats ---------- */
  const Data = {
    async chats() {
      const { data, error } = await db.from('chats')
        .select('id, title, updated_at, summary, compressed_upto')
        .order('updated_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    },
    /* The rolling context summary, kept server-side so reopening a long chat
       doesn't pay to summarise it all over again. */
    async setChatSummary(id, summary, upto) {
      await db.from('chats').update({ summary, compressed_upto: upto }).eq('id', id);
    },
    async messages(chatId) {
      const { data, error } = await db.from('messages').select('role, content').eq('chat_id', chatId).order('created_at');
      if (error) throw error;
      return data;
    },
    async createChat(title) {
      const { data, error } = await db.from('chats').insert({ owner: user.id, title }).select('id, title, updated_at').single();
      if (error) throw error;
      return data;
    },
    async renameChat(id, title) {
      await db.from('chats').update({ title, updated_at: new Date().toISOString() }).eq('id', id);
    },
    async touchChat(id) {
      await db.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', id);
    },
    async deleteChat(id) { await db.from('chats').delete().eq('id', id); },
    async addMessage(chatId, role, content) {
      const { data, error } = await db.from('messages').insert({ chat_id: chatId, owner: user.id, role, content }).select('id').single();
      if (error) throw error;
      return data.id;
    },
    async setMessage(id, content) { await db.from('messages').update({ content }).eq('id', id); },

    /* ---------- key pool ---------- */
    async myKeys() {
      const { data, error } = await db.from('donated_keys')
        .select('id, label, masked, status, uses, last_error, created_at, provider')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    async donate(apiKey, label, provider) {
      apiKey = apiKey.trim();
      const p = Models.PROVIDERS[provider];
      if (!p) throw new Error('pick a provider');
      if (!p.test.test(apiKey)) throw new Error(`that does not look like a ${p.name.toLowerCase()} key (${p.hint})`);
      const { error } = await db.from('donated_keys')
        .insert({ owner: user.id, api_key: apiKey, provider, label: label.trim() || 'my key' });
      if (error) throw new Error(error.code === '23505' ? 'that key is already in the pool' : error.message);
    },
    async removeKey(id) { await db.from('donated_keys').delete().eq('id', id); },
    async pool() {
      const { data } = await db.from('pool_public').select('key_id, masked, status, uses, donor, provider').order('uses', { ascending: false }).limit(50);
      const rows = data || [];
      return {
        rows,
        stats: {
          keys: rows.length,
          healthy: rows.filter(r => r.status === 'ok').length,
          requests: rows.reduce((a, r) => a + r.uses, 0),
        },
      };
    },

    /* Which providers the pool can actually serve right now, each with the model
       it currently resolves to. The picker offers these rather than a wall of
       model names that goes stale every time a vendor retires a snapshot. */
    async providers() {
      const { data: { session } } = await db.auth.getSession();
      if (!session) return [];
      const res = await fetch(`${URL}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ action: 'models' }),
      });
      if (!res.ok) return [];
      const { providers } = await res.json();
      return providers || [];
    },

    /* ---------- chat completion, proxied through the edge function ---------- */
    async stream({ model, messages, signal, onToken, onRoute }) {
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new Error('session expired — sign in again');

      const res = await fetch(`${URL}/functions/v1/chat`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) {
        let msg = `${res.status}`, code = '';
        try { const j = await res.json(); msg = j.error || msg; code = j.code || ''; } catch (e) {}
        const err = new Error(msg); err.status = res.status; err.code = code; throw err;
      }
      // which provider/model the pool actually picked — auto can land anywhere
      if (onRoute) { const r = res.headers.get('X-Jio-Route'); if (r) onRoute(r); }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return text;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (delta) { text += delta; onToken(delta, text); }
          } catch (e) {}
        }
      }
      return text;
    },
  };

  global.Supa = { db, Auth, Data };
})(window);

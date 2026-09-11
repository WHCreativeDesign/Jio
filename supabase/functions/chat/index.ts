// jio chat proxy. Holds the donated key pool server-side and streams Groq back
// to the browser, so a raw key is never sent to a client.
// verify_jwt is off so CORS preflight succeeds; the bearer token is verified below.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GROQ = "https://api.groq.com/openai/v1/chat/completions";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign in to chat" }, 401);
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return json({ error: "session expired — sign in again" }, 401);

  let body: { model?: string; messages?: unknown[] };
  try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }
  const { model, messages } = body;
  if (!model || !Array.isArray(messages) || !messages.length) return json({ error: "model and messages are required" }, 400);

  // wake any key whose cooldown has passed
  await admin.from("donated_keys").update({ status: "ok", cooling_until: null })
    .eq("status", "cooling").lt("cooling_until", new Date().toISOString());

  // round-robin: least recently used healthy key first
  const { data: keys } = await admin.from("donated_keys")
    .select("id, api_key, masked").eq("status", "ok")
    .order("last_used_at", { ascending: true, nullsFirst: true }).limit(4);

  if (!keys?.length) return json({ error: "the pool is empty — donate a groq key to get jio running", code: "no_keys" }, 503);

  let lastError = "";
  for (const key of keys) {
    let res: Response;
    try {
      res = await fetch(GROQ, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.api_key}` },
        body: JSON.stringify({ model, messages, stream: true, temperature: 0.7, max_tokens: 4096 }),
      });
    } catch (e) {
      lastError = String(e);
      continue;
    }

    if (res.ok && res.body) {
      await admin.rpc("note_key_use", { key_id: key.id });
      return new Response(res.body, {
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Jio-Key": key.masked },
      });
    }

    lastError = await res.text().catch(() => `${res.status}`);
    try { lastError = JSON.parse(lastError).error?.message ?? lastError; } catch { /* plain text */ }

    if (res.status === 401 || res.status === 403) {
      await admin.from("donated_keys").update({ status: "dead", last_error: lastError }).eq("id", key.id);
    } else if (res.status === 429) {
      await admin.from("donated_keys").update({
        status: "cooling", last_error: lastError,
        cooling_until: new Date(Date.now() + 60_000).toISOString(),
      }).eq("id", key.id);
    } else {
      // model or request problem, not the key's fault — surface it as-is
      return json({ error: lastError }, res.status);
    }
  }

  return json({ error: `every key in the pool is resting. last: ${lastError}`, code: "pool_exhausted" }, 503);
});

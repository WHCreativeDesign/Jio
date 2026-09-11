// jio chat proxy. Holds the donated key pool server-side and streams Groq back
// to the browser, so a raw key is never sent to a client.
// verify_jwt is off so CORS preflight succeeds; the bearer token is verified below.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GROQ = "https://api.groq.com/openai/v1";
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

/** Healthy keys, least recently used first. Wakes any whose cooldown has passed. */
async function poolKeys() {
  await admin.from("donated_keys").update({ status: "ok", cooling_until: null })
    .eq("status", "cooling").lt("cooling_until", new Date().toISOString());
  const { data } = await admin.from("donated_keys")
    .select("id, api_key").eq("status", "ok")
    .order("last_used_at", { ascending: true, nullsFirst: true }).limit(4);
  return data ?? [];
}

async function retireKey(id: string, status: number, message: string) {
  if (status === 401 || status === 403) {
    await admin.from("donated_keys").update({ status: "dead", last_error: message }).eq("id", id);
  } else if (status === 429) {
    await admin.from("donated_keys").update({
      status: "cooling", last_error: message,
      cooling_until: new Date(Date.now() + 60_000).toISOString(),
    }).eq("id", id);
  }
}

async function readError(res: Response) {
  const raw = await res.text().catch(() => `${res.status}`);
  try { return JSON.parse(raw).error?.message ?? raw; } catch { return raw; }
}

/** Groq's live catalogue, minus anything that isn't a chat model. */
async function listModels(keys: { id: string; api_key: string }[]) {
  const skip = /whisper|tts|guard|embed|prompt-?guard|safety/i;
  for (const key of keys) {
    const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key.api_key}` } })
      .catch(() => null);
    if (!res) continue;
    if (!res.ok) { await retireKey(key.id, res.status, await readError(res)); continue; }
    const body = await res.json();
    const models = (body.data ?? [])
      .filter((m: { id: string; active?: boolean }) => m.active !== false && !skip.test(m.id))
      .map((m: { id: string; context_window?: number }) => ({ id: m.id, context: m.context_window ?? null }));
    return json({ models });
  }
  return json({ error: "could not reach groq with any pooled key", code: "pool_exhausted" }, 503);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "sign in to chat" }, 401);
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "session expired — sign in again" }, 401);

    let body: { action?: string; model?: string; messages?: unknown[] };
    try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }

    const keys = await poolKeys();
    if (!keys.length) return json({ error: "the pool is empty — donate a groq key to get jio running", code: "no_keys" }, 503);

    if (body.action === "models") return await listModels(keys);

    const { model, messages } = body;
    if (!model || !Array.isArray(messages) || !messages.length) return json({ error: "model and messages are required" }, 400);

    let lastError = "";
    for (const key of keys) {
      let res: Response;
      try {
        res = await fetch(`${GROQ}/chat/completions`, {
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
        // header values must be Latin-1, so nothing derived from a masked key goes here
        return new Response(res.body, {
          headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      lastError = await readError(res);
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await retireKey(key.id, res.status, lastError);
      } else {
        // a bad model or malformed request is not the key's fault — surface it as-is
        return json({ error: lastError }, res.status);
      }
    }

    return json({ error: `every key in the pool is resting. last: ${lastError}`, code: "pool_exhausted" }, 503);
  } catch (e) {
    // a thrown error would otherwise return a platform 500 with no CORS headers,
    // which reaches the browser as an unexplained "Failed to fetch"
    console.error(e);
    return json({ error: `jio's proxy hit an error: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

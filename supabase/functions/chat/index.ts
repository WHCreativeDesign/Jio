// jio chat proxy. Holds the donated key pool server-side and streams a provider
// back to the browser, so a raw key is never sent to a client.
//
// Four providers, all speaking the OpenAI shape. A model arrives as
// "provider:model-id"; "auto" means "give me the best available Qwen3-class
// model from whichever provider still has headroom", which is what lets one
// pool of free keys keep answering after any single provider taps out.
//
// verify_jwt is off so CORS preflight succeeds; the bearer token is verified below.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Provider = "groq" | "cohere" | "gemini" | "nvidia";
type Key = { id: string; api_key: string };

const PROVIDERS: Record<Provider, { base: string; prefer: RegExp[] }> = {
  // qwen3.8-27b is the target everywhere; groq is the only one that has it, so
  // the others list their closest equivalent instead. Verified against each
  // provider's live catalogue — ladders, not hardcoded single ids, because
  // every one of these vendors retires model names on their own schedule.
  groq: {
    base: "https://api.groq.com/openai/v1",
    prefer: [/^qwen\/qwen3\.8-27b$/, /^qwen\/qwen3[\d.]*-27b$/, /qwen/, /gpt-oss-120b/, /gpt-oss/],
  },
  nvidia: {
    // nvidia's catalogue advertises plenty this account can't actually call
    // (404 "not found for account") and some that are EOL (410), so the ladder
    // leads with what was verified live and the runtime walks past the rest.
    base: "https://integrate.api.nvidia.com/v1",
    prefer: [/qwen.*(27|30|32)b/, /qwen/, /deepseek-v4-flash/, /nemotron.*(30b|nano-3)/, /deepseek/],
  },
  gemini: {
    // gemma over this endpoint 500s; the gemini-*-flash line is what actually serves
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    prefer: [/gemini-[\d.]+-flash$/, /gemini-[\d.]+-flash-lite$/, /flash/],
  },
  cohere: {
    base: "https://api.cohere.ai/compatibility/v1",
    prefer: [/^command-a-\d/, /command-a-reasoning/, /command-a-plus/, /command-r-plus/, /^command-/],
  },
};

// Order auto walks when it needs somewhere to send a request.
const AUTO: Provider[] = ["groq", "nvidia", "gemini", "cohere"];
const isProvider = (p: string): p is Provider => p in PROVIDERS;

// Anything that isn't a text chat model. These catalogues are full of embedders,
// rerankers, TTS, video and image endpoints that would only break at call time.
const NOT_CHAT =
  /embed|rerank|transcrib|whisper|tts|guard|safety|moderat|imagen|veo-|lyria|-image|diffusion|live-|nemoretriever|topic-control|vision/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // so the client can show which provider/model actually served the reply
  "Access-Control-Expose-Headers": "X-Jio-Route",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/* ---------- keys ---------- */

/** Healthy keys for one provider: fewest recent failures first, then least
    recently used, so load spreads evenly and every free tier gets worked. */
async function poolKeys(provider: Provider): Promise<Key[]> {
  await admin.from("donated_keys").update({ status: "ok", cooling_until: null })
    .eq("status", "cooling").lt("cooling_until", new Date().toISOString());
  const { data } = await admin.from("donated_keys")
    .select("id, api_key").eq("status", "ok").eq("provider", provider)
    .order("fails", { ascending: true })
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .limit(8);
  return data ?? [];
}

/** How long the provider actually wants us to wait, if it said so. Resting a
    key longer than it asked for is quota left on the table. */
function retryAfter(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  if (ra && /^\d+$/.test(ra.trim())) return parseInt(ra, 10);
  const reset = res.headers.get("x-ratelimit-reset-requests") || res.headers.get("x-ratelimit-reset-tokens");
  const m = reset?.match(/(?:(\d+)m)?([\d.]+)s/);
  if (m) return Math.ceil(parseInt(m[1] ?? "0", 10) * 60 + parseFloat(m[2]));
  return null;
}

async function killKey(id: string, message: string) {
  await admin.from("donated_keys").update({ status: "dead", last_error: message }).eq("id", id);
}
async function coolKey(id: string, message: string, secs: number | null) {
  await admin.rpc("cool_key", { key_id: id, message, secs });
}

async function readError(res: Response) {
  const raw = await res.text().catch(() => `${res.status}`);
  try { return JSON.parse(raw).error?.message ?? JSON.parse(raw).detail ?? raw; } catch { return raw; }
}

/* ---------- catalogue ---------- */

// Per-isolate, so a burst of page loads doesn't re-ask four vendors for a list
// that changes maybe weekly.
const cache = new Map<Provider, { at: number; ids: string[] }>();
const TTL = 10 * 60 * 1000;

async function catalogue(provider: Provider, keys: Key[]): Promise<string[]> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL) return hit.ids;
  for (const key of keys) {
    const res = await fetch(`${PROVIDERS[provider].base}/models`, {
      headers: { Authorization: `Bearer ${key.api_key}` },
    }).catch(() => null);
    if (!res) continue;
    if (!res.ok) {
      const msg = await readError(res);
      if (res.status === 401 || res.status === 403) await killKey(key.id, msg);
      continue;
    }
    const body = await res.json().catch(() => null);
    const ids: string[] = (body?.data ?? [])
      .filter((m: { id?: string; active?: boolean }) => m.id && m.active !== false && !NOT_CHAT.test(m.id))
      .map((m: { id: string }) => m.id);
    if (ids.length) { cache.set(provider, { at: Date.now(), ids }); return ids; }
  }
  return [];
}

/** This provider's closest stand-in for qwen3.8-27b, best first. */
function ladder(provider: Provider, ids: string[]): string[] {
  const out: string[] = [];
  for (const re of PROVIDERS[provider].prefer) {
    for (const id of ids) if (re.test(id) && !out.includes(id)) out.push(id);
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/* ---------- request ---------- */

type Plan = { provider: Provider; models: string[]; keys: Key[] };

/** Every model this provider can stand in with, best first. */
async function planFor(p: Provider): Promise<Plan | null> {
  const keys = await poolKeys(p);
  if (!keys.length) return null;
  const ids = await catalogue(p, keys);
  if (!ids.length) return null;
  return { provider: p, models: ladder(p, ids).slice(0, 4), keys };
}

/** Where this request can be served from, in order of preference.
    "auto"              — every provider, each at its best
    "groq"              — that provider, best model first, others as backup
    "groq:some-model"   — pinned exactly; predictability once someone chose */
async function plan(choice: string): Promise<Plan[]> {
  if (choice && choice.includes(":")) {
    const i = choice.indexOf(":");
    const p = choice.slice(0, i), id = choice.slice(i + 1);
    if (!isProvider(p)) return [];
    const keys = await poolKeys(p);
    return keys.length ? [{ provider: p, models: [id], keys }] : [];
  }
  if (isProvider(choice)) {
    const one = await planFor(choice);
    return one ? [one] : [];
  }
  const plans: Plan[] = [];
  for (const p of AUTO) {
    const one = await planFor(p);
    if (one) plans.push(one);
  }
  return plans;
}

/** The picker offers providers, not a wall of model names — each provider
    resolves to whatever it currently serves that's closest to qwen3.8-27b. */
async function listProviders() {
  const out: { provider: Provider; best: string }[] = [];
  await Promise.all(AUTO.map(async (p) => {
    const one = await planFor(p);
    if (one) out.push({ provider: p, best: one.models[0] });
  }));
  out.sort((a, b) => AUTO.indexOf(a.provider) - AUTO.indexOf(b.provider));
  if (!out.length) return json({ error: "no provider could be reached with any pooled key", code: "pool_exhausted" }, 503);
  return json({ providers: out });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "sign in to chat" }, 401);
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "session expired — sign in again" }, 401);

    let body: { action?: string; model?: string; messages?: unknown[]; max_tokens?: number };
    try { body = await req.json(); } catch { return json({ error: "bad request body" }, 400); }

    if (body.action === "models") return await listProviders();

    const { messages } = body;
    if (!Array.isArray(messages) || !messages.length) return json({ error: "messages are required" }, 400);

    const plans = await plan(body.model ?? "auto");
    if (!plans.length) {
      return json({ error: "no healthy key for that provider — donate one on the key pool page", code: "no_keys" }, 503);
    }

    let lastError = "";
    // provider → model → key. Every loop exists because a real failure mode put
    // it there: a provider taps out, a catalogue advertises a model the account
    // can't actually call (nvidia 404s these), a single key hits its minute limit.
    for (const p of plans) {
      for (const model of p.models) {
        for (const key of p.keys) {
          let res: Response;
          try {
            res = await fetch(`${PROVIDERS[p.provider].base}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.api_key}` },
              body: JSON.stringify({
                model, messages, stream: true,
                temperature: 0.7,
                max_tokens: Math.min(body.max_tokens ?? 4096, 8192),
              }),
            });
          } catch (e) {
            lastError = String(e);
            continue;
          }

          if (res.ok && res.body) {
            await admin.rpc("note_key_use", { key_id: key.id });
            return new Response(res.body, {
              headers: {
                ...CORS,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                // Latin-1 only in header values, so nothing derived from a key goes here
                "X-Jio-Route": `${p.provider}/${model}`,
              },
            });
          }

          lastError = await readError(res);
          if (res.status === 401 || res.status === 403) {
            await killKey(key.id, lastError);
            continue;                       // next key
          }
          if (res.status === 429) {
            await coolKey(key.id, lastError, retryAfter(res));
            continue;                       // next key
          }
          // 404 unavailable to this account, 410 retired, 400 rejected: the
          // model is the problem, not the key, so stop burning keys on it
          if (res.status === 404 || res.status === 410 || res.status === 400) break;
          // 413: the request (a canvas conversation's history, say) is too big
          // for this key's per-minute token budget. Waiting doesn't fix that —
          // another key, model or provider might have room, so try on without
          // marking this key unhealthy.
          if (res.status === 413) continue;
          if (res.status >= 500) continue;  // provider hiccup: another key, then another model
          // Anything else unexpected: "auto" exists to survive exactly this —
          // one provider misbehaving must not sink the whole request when
          // others in the plan haven't been tried yet.
          continue;
        }
      }
    }

    return json({
      error: `every route is resting right now. last: ${lastError}`,
      code: "pool_exhausted",
    }, 503);
  } catch (e) {
    // a thrown error would otherwise return a platform 500 with no CORS headers,
    // which reaches the browser as an unexplained "Failed to fetch"
    console.error(e);
    return json({ error: `jio's proxy hit an error: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});

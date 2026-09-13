# jio

A clean, geometric, playful personal agent. The mascot is just eyes.

Static front end on GitHub Pages, Supabase for accounts, storage, and the model proxy.

## Pages

- `index.html` — sign in → chat, canvas mode, key pool
- `lab.html` — eye lab: every expression the `JioEyes` engine can make, public, no login

## Desktop

`desktop/` wraps this same web app in Electron for a Windows build that
auto-updates from GitHub Releases and runs an offline local model (bundled
llama.cpp) alongside the cloud providers. See `desktop/README.md`.

## How it works

**Accounts.** Email + password, no 2FA, no PIN in front of it. A trigger mirrors each new
user into `profiles`.

**Boot never hangs.** `Auth.restore()` (and `signIn`/`signUp`) race the real Supabase call
against a plain `setTimeout`, so a call that can't complete — a blocked or dead network, or
supabase-js's own known `getSession()` deadlock on a stale persisted session — falls through
to the sign-in screen instead of spinning forever. A `#boot` splash (just the eyes,
breathing) covers the gap; a 12s last-resort watchdog and an `unhandledrejection` listener
back that up in case anything upstream is ever missed.

**Providers.** Four of them — Groq, NVIDIA, Gemini and Cohere — all reached over their
OpenAI-compatible endpoints, so one code path serves all four. A model travels as
`provider:model-id`.

**You pick a provider, not a model.** The picker is Auto, Groq, NVIDIA, Gemini, Cohere —
nothing else. Every one of these vendors retires model names on their own schedule, so
there's no list to go stale: the edge function asks each provider what it actually serves,
drops everything that isn't a text chat model (embedders, rerankers, TTS, video, image),
and resolves each provider to whichever of its models is closest to `qwen/qwen3.8-27b` —
the best of this bunch for code. Today that's Qwen3.8 27B on Groq, DeepSeek V4 Flash on
NVIDIA, Gemini Flash, and Command A on Cohere, but none of those names are written down
anywhere; they're matched live.

**Auto.** The default, and the point of the whole thing: it walks every provider that still
has headroom, each at its best, so the pool keeps answering after any single one taps out.
Whichever route served a reply is named under the composer.

**Chat.** The browser never talks to a provider. It calls the `chat` edge function with the
user's access token; the function picks a donated key server-side, streams the provider
back, and records the result. `X-Jio-Route` says which provider and model actually served it.

**Getting the most out of the pool.** Keys are picked fewest-failures-first, then
least-recently-used, so load spreads instead of hammering one free tier. A key that returns
401/403 is marked dead. One that returns 429 rests exactly as long as the provider asked
(`Retry-After`, or Groq's `x-ratelimit-reset-*`), and only falls back to a 1m/2m/5m/15m
backoff when it didn't say — resting a key longer than it asked for is quota left on the
table. A success clears the failure streak. Requests walk provider → model → key, because
each of those fails on its own: a provider taps out, a catalogue advertises a model the
account can't actually call (NVIDIA 404s these) or that's been retired (410), a single key
hits its minute limit.

**Context compression.** Every turn resends the history, which is how a long chat quietly
multiplies what the pool pays for. Past a character budget, the older turns are folded into
one dense summary by the cheapest model on hand and only the recent ones travel intact. The
summary lives on the chat row, so reopening it later doesn't pay to redo the work, and the
thread shows one quiet line where it happened.

**Key pool.** Donated keys live in `donated_keys`, which is RLS'd so you can only ever read
your own row. The raw key is never exposed to any client — the community listing reads
`pool_public`, a mirror table carrying only a masked key, donor handle, provider, status,
and use count, kept in sync by trigger.

**Canvas mode.** Asks the model for one self-contained ` ```html ` block and renders it in a
sandboxed iframe beside the thread — preview/code tabs, copy, open in new tab. It streams
into the panel live.

**Mascot.** One mascot, in the thread. It sits in the greeting, then glides into the avatar
slot of each new reply — position, size, and corner radius tweening together, leaning into
the direction of travel. It goes `focused` while a reply streams in, then reads a
`{{mood:x}}` tag the model is asked to lead every reply with — stripped wherever it lands,
since models cheerfully put it at the end instead —
and holds that expression for a couple seconds before settling to neutral — the model
picks its own reaction instead of the UI faking one.

## Schema

| table | what |
| --- | --- |
| `profiles` | handle per user, filled by trigger on signup |
| `donated_keys` | raw key + provider + status + failure streak + use count. RLS: owner only |
| `pool_public` | masked mirror for the community listing. RLS: any signed-in user reads |
| `chats` / `messages` | conversation history, plus the rolling context summary. RLS: owner only |

Edge function: `chat` (JWT verified in the body so CORS preflight works).

## Supabase in this repo

`supabase/` is the source of truth for the linked project:

```
supabase/config.toml                project ref + function settings
supabase/migrations/*.sql           schema, RLS, triggers
supabase/functions/chat/index.ts    the multi-provider proxy
```

## Project config

One setting isn't in the repo — in the Supabase dashboard under
**Authentication → Sign In / Providers → Email**, turn **Confirm email** off if you want
accounts to work the moment someone signs up. With it on, `signUp` returns no session and
jio tells the user to check their inbox first.

## Files

```
css/app.css      app styles (Claude-shaped dark + light)
css/lab.css      eye lab styles
js/eyes.js       JioEyes canvas engine
js/tween.js      Tween.run() — wraps a DOM mutation in a View Transition
js/supa.js       Supabase client: auth (timeout-guarded) + data + streaming
js/models.js     providers, model labels, route labels, key formats
js/mascot.js     in-thread mascot
js/chat.js       app orchestration, canvas, pool UI
js/app.js        eye lab
js/vendor/       marked, DOMPurify, supabase-js
```

## Run locally

```
python3 -m http.server 8765
```

## Loading

Nothing external blocks first paint. The Google Fonts stylesheet loads with
`media="print"` and is switched on at `onload`, and every script is `defer`red, so a
filtered or slow network can't leave the page blank — it renders with Georgia and swaps
the webfont in if and when it arrives. A script that throws surfaces a banner rather
than a blank screen.

## Fonts

The UI asks for `Anthropic Sans` / `Anthropic Serif` first and falls back to system sans +
Newsreader. Those brand fonts aren't redistributable, so the fallback is what most people
will see.

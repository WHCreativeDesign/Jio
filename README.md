# jio

A clean, geometric, playful personal agent. The mascot is just eyes.

Static front end on GitHub Pages, Supabase for accounts, storage, and the model proxy.

## Pages

- `index.html` — PIN gate → sign in → chat, canvas mode, key pool
- `lab.html` — eye lab: every expression the `JioEyes` engine can make

## How it works

**Accounts.** Email + password, no 2FA. A trigger mirrors each new user into `profiles`.

**Chat.** The browser never talks to Groq. It calls the `chat` edge function with the user's
access token; the function picks a donated key server-side, streams Groq back, and records
the result. A key that returns 401/403 is marked dead, one that returns 429 cools for a
minute, and the next request tries the next key.

**Key pool.** Donated keys live in `donated_keys`, which is RLS'd so you can only ever read
your own row. The raw key is never exposed to any client — the community listing reads
`pool_public`, a mirror table carrying only a masked key, donor handle, status, and use
count, kept in sync by trigger.

**Canvas mode.** Asks the model for one self-contained ` ```html ` block and renders it in a
sandboxed iframe beside the thread — preview/code tabs, copy, open in new tab. It streams
into the panel live.

**Mascot.** One mascot, in the thread. It sits in the greeting, then glides into the avatar
slot of each new reply — position, size, and corner radius tweening together, leaning into
the direction of travel. It thinks while streaming and reacts to what happens.

## Schema

| table | what |
| --- | --- |
| `profiles` | handle per user, filled by trigger on signup |
| `donated_keys` | raw key + status + use count. RLS: owner only |
| `pool_public` | masked mirror for the community listing. RLS: any signed-in user reads |
| `chats` / `messages` | conversation history. RLS: owner only |

Edge function: `chat` (JWT verified in the body so CORS preflight works).

## Supabase in this repo

`supabase/` is the source of truth for the linked project:

```
supabase/config.toml                project ref + function settings
supabase/migrations/*.sql           schema, RLS, triggers
supabase/functions/chat/index.ts    the Groq proxy
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
js/gate.js       shared PIN gate
js/supa.js       Supabase client: auth + data + streaming
js/groq.js       model list
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

# jio

A clean, geometric, playful personal agent. The mascot is just eyes.

Static site, no build step. Deployed to GitHub Pages on every push to `main`.

## Pages

- `index.html` — the app: PIN gate, Claude-shaped chat shell, canvas mode, key pool
- `lab.html` — eye lab: every expression the `JioEyes` engine can make

## How it works

- **Chat** streams from Groq's OpenAI-compatible endpoint straight from the browser. Chats live in `localStorage`.
- **Canvas mode** asks the model for a single self-contained ` ```html ` block and renders it in a sandboxed iframe beside the thread (preview / code tabs, copy, open in new tab).
- **Key pool** — jio runs on donated free Groq keys, picked round-robin. A key that 429s rests, a 401 is dropped. Right now donated keys are stored in *your* browser only; the community table is placeholder data until a backend lands.
- **Mascot** hops to whatever has focus, tracks the cursor, thinks while streaming, and reacts to what happens.

## Files

```
css/app.css      app styles (cream + blue, dark theme)
css/lab.css      eye lab styles
js/eyes.js       JioEyes canvas engine
js/gate.js       shared PIN gate
js/groq.js       streaming client + model list
js/pool.js       key pool (local storage + placeholder community rows)
js/mascot.js     hopping mascot
js/chat.js       app orchestration, canvas, pool UI
js/app.js        eye lab
js/vendor/       marked, DOMPurify
```

## Run locally

```
python3 -m http.server 8765
```

## Fonts

The UI asks for `Anthropic Sans` / `Anthropic Serif` first and falls back to system sans + Newsreader (Google Fonts). Those brand fonts aren't redistributable, so the fallback is what most people will see.

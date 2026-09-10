# JIO

Geometric, clean, futuristic, playful personal agent.

This repo currently holds the **eye lab** — a static demo of JIO's expressive eyes, in the lineage of Anki Vector / Cozmo / EMO.

## Live

Deployed to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

## Run locally

Any static server works:

```
python3 -m http.server 8765
```

Open `http://localhost:8765`. The site is behind a PIN gate (client-side, session-scoped).

## Structure

- `index.html` — PIN gate + eye lab
- `js/eyes.js` — `JioEyes` engine: rounded-rect eyes with per-corner radii, angled upper/lower lids, gaze + parallax, auto-blink, idle wander, and per-expression FX (bounce, pulse, beat, shake, tremble, spin, tears, zz, glitch, scan, orbit)
- `js/app.js` — gate logic, expression grid, tour, palette, keyboard shortcuts
- `css/style.css`

## Expressions

neutral · happy · laugh · excited · love · sad · cry · angry · rage · surprised · scared · sleepy · sleeping · wink · suspicious · confused · curious · thinking · focused · bored · smirk · proud · dizzy · dead · glitch · scanning · loading

## Using the engine

```js
const eyes = new JioEyes(canvas, { color: '#38f2ff', size: 0.36 });
eyes.start();
eyes.set('happy');
eyes.look(0.4, -0.2);   // -1..1
eyes.blink();
```

# jio desktop

The same web app (`../index.html`, `../css`, `../js` — copied in at build time by
`scripts/copy-web.js`, not duplicated by hand), wrapped in Electron so it can
ship as a Windows `.exe`, auto-update itself from GitHub Releases, and run a
model fully offline on the user's own GPU.

## How it fits together

- **`src/main.js`** — the whole app. Starts a tiny local HTTP server (so the
  page runs from `http://127.0.0.1:8791`, not `file://`, which keeps `fetch()`
  and Supabase's client library behaving normally), opens the window, spawns
  the bundled `llama-server.exe` pointed at a downloaded model, and calls
  `electron-updater` to check GitHub Releases for a newer version.
- **`src/preload.js`** — exposes `window.jioDesktop` to the page: a
  `localBaseUrl`, live download/startup status, and nothing else. This is the
  *only* thing that tells the app it's running inside Electron at all — the
  identical `index.html` on GitHub Pages never sees this global, so `js/chat.js`,
  `js/models.js` and `js/supa.js` degrade to exactly their current web
  behavior when it's absent.
- **Cloud providers are unchanged** — still proxied through the Supabase edge
  function. Only `model: "local"` skips that entirely and talks straight to
  `127.0.0.1:8790`, the bundled llama.cpp server.

## Local model

Default: **Qwen2.5-3B-Instruct, Q4_K_M** (~2GB) — chosen to comfortably fit a
4GB card (a GTX 1050 Ti was the target) fully offloaded to GPU, leaving room
for context. Downloaded from Hugging Face on first run into
`app.getPath('userData')/models/`, not bundled in the installer — that keeps
the installer itself small and auto-updates fast, since they only ship app
code, not multi-gigabyte weights.

To change the model, edit `MODEL_FILE` / `MODEL_URL` in `src/main.js`. Swapping
in something bigger than ~3B means also tuning `-ngl` in `startLocalModel()` —
it currently requests full GPU offload (`999`), which is only safe because the
default model comfortably fits in 4GB.

## Local-only features

- **Live "thinking."** Before the real answer, the local model is asked for a
  one-line plan, streamed into the same status header the cloud path uses —
  real content instead of the canned rotating phrases, since a local call is
  free and fast enough to spend on this.
- **Context compression prefers local.** `cheapModel()` in `js/chat.js` picks
  `local` once it's ready, ahead of the cheapest cloud provider, for folding
  old turns into a summary.
- **Streaming** comes for free — llama.cpp's server speaks the same
  OpenAI-compatible SSE shape the cloud proxy already does, so the existing
  reader in `js/supa.js` needed no changes to parse it.

## Running it

```
cd desktop
npm install
npm start          # copies ../{index.html,css,js} into web/, then launches
```

## Building a real Windows installer

This has to happen on a Windows runner with real internet access to fetch the
CUDA llama.cpp binaries — neither of which this repo's usual dev/CI
environment has. `.github/workflows/release-desktop.yml` does it: push a tag
matching `desktop-v*` (or run it manually from the Actions tab) and it
builds on `windows-latest`, downloads the matching llama.cpp release,
and publishes the installer to this repo's GitHub Releases —
which is also where `electron-updater` looks for new versions, so
that's the entire release step.

**Not yet verified against a real Windows/CUDA machine or a live GitHub Actions
run** — the main-process logic (static server, IPC bridge, graceful handling of
a missing llama.cpp binary) was exercised locally, but the actual llama.cpp
binary fetch, GPU offload behavior, and the signed/unsigned installer
experience all need a real trial run.

## Known gaps

- **Unsigned installer.** Windows SmartScreen will warn ("unrecognized
  publisher") until this is signed with a code-signing certificate — those
  cost money and aren't set up here. Worth doing before wide distribution.
- **The llama.cpp asset-matching in the workflow is pattern-based, not
  pinned** — their release asset names have shifted before (CUDA toolkit
  version in the filename, the cudart runtime moving in/out of the main zip).
  If a release build fails at the "Fetch llama.cpp" step, that's almost
  certainly why — check the actual asset names on
  https://github.com/ggml-org/llama.cpp/releases and adjust the `-match`
  patterns in the workflow.

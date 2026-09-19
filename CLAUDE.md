# Jio: Claude-Powered Conversation Platform

Jio is an AI conversation platform built around Claude's API, featuring live word-by-word delivery, persistent memory, canvas collaboration, and API key management. Available as a web app and Electron desktop client with offline local LLM support.

## Architecture

**Data Layer**: Supabase PostgreSQL with RLS policies for multi-user isolation. User sessions, messages, memories, and canvas states are persisted server-side.

**Message Flow**: Claude API streaming → word pacing engine → DOM rendering. Messages arrive as token streams; the live pacing system queues and renders words individually with rhythmic delays (base 62ms + jitter) to create natural, conversational delivery.

**View Switching**: Single-page app with state-driven view rendering (Chat, Memory, Canvas, Settings). View state lives in `currentView` global; switching resets scroll, focuses input, and mounts/unmounts component handlers.

**Memory System**: User-level persistent memory stored in Supabase `memories` table. Memories are editable in-place within the Chat view, tagged with `[mem:id]` markers injected into message context. Loading a chat re-injects prior memory tags to restore context. Token cost optimized via 10-message window + memory injection (net savings ~400 chars/turn after ~14 messages).

## File Structure

```
index.html           Main app shell, nav, view containers
js/
  chat.js            Message handling, live mode, memory system, streaming
  supa.js            Supabase client wrapper (auth, messages, memories, canvas)
  mascot.js          Eye animation state machine (thinking, speaking, breathing)
  keys.js            Claude API key management
  canvas.js          Collaborative canvas (drawing, shapes, history)
css/
  app.css            Single stylesheet (7800+ lines, namespaced classes)
  normalize.css      CSS reset
desktop/
  src/main.js        Electron main process, app window, updater
  src/preload.js     IPC bridge between renderer and main
  package.json       Electron build config (NSIS/DMG/Zip targets)
.github/workflows/
  pages.yml          GitHub Pages deployment (index, css, js → _site/)
  release-desktop.yml Electron builds (Windows CUDA, macOS arm64+x64)
supabase/
  migrations/        Database schema (auth, messages, memories, canvas)
  functions/         Edge Functions (if any)
```

## Key Patterns

**Streaming & Pacing**: Chat messages arrive as event streams; the `LIVE_PACE` object controls timing (base 62ms per word, 130ms clause pause, 290ms sentence pause). A word queue decouples network delivery from DOM rendering, enabling smooth, independent pacing.

**State Management**: No framework—globals and event listeners. `currentView` controls UI, `sessionUserId` tracks auth, message history lives in Supabase. Component init/cleanup happens on view switch (see `renderView()`).

**Animation**: Eye state tied to message flow: breathing on thinking (2.5s, -5px translateY), speaking (1.5s, -2.5px translateY). CSS classes toggle state; JS updates via `eyeStage.className`.

**Canvas Collab**: Real-time drawing synced to Supabase via polling. Undo/redo handled client-side; full history stored server-side.

## Recent Features

**Live Mode** (0.8.0+): Word-by-word rendering with pacing engine. Reduces perceived latency by decoupling network speed from UX feedback. Eye animations provide visual rhythm.

**Memory System** (0.9.0+): Persistent, editable memory accessible within Chat view. Memories tagged `[mem:id]` and injected into message context. Supabase RLS ensures user isolation. Reduces token spend on long conversations via 10-message rolling window.

**Key Pool**: Multiple API keys allowed; app round-robins or falls back on rate limit. Managed in Settings.

## Development

**Local Dev**:
- Web: `cd /home/user/Jio && python -m http.server 8000`
- Desktop: `cd desktop && npm install && npm start`

**Testing Memory & Live**: Open Chat, enable Memory view, add a memory, type a message. Memory context injects; live mode paces word delivery with eye animations.

**CSS Namespacing**: Classes prefixed by component (`.live-`, `.mem-`, `.eye-`, etc.) to avoid collisions. Watch for state classes on live-mode overlay (`.live-thinking`, `.live-speaking`, `.live-busy`, `.live-said`).

## Deployment

**Web** (GitHub Pages): Commits to `main` trigger `.github/workflows/pages.yml`. Builds copy web files to `_site/`, publishes to `gh-pages` branch.

**Desktop** (Electron):
- Windows: NSIS installer, CUDA-enabled llama.cpp binary bundled
- macOS: DMG + Zip, native arm64/x64 llama.cpp builds, unsigned (no codesign cert in CI)
- Release: Bump `desktop/package.json` version, push to `main`. CI auto-detects version bump, builds, publishes to GitHub Releases. `electron-updater` checks releases for updates.

## API Keys & Auth

User auth via Supabase. Claude API keys stored in Supabase encrypted column (never logged, never sent client-side plaintext). App includes user-facing key pool UI for multiple keys.

## Notes

- **Eye animation & CSS collisions**: State classes (`.thinking`, `.live`, etc.) can collide with existing chat/canvas styles. All live-mode states prefixed: `.live-thinking`, `.live-speaking`, `.live-busy`, `.live-said`.
- **Message window**: Reduced to 10 messages on memory inject to save tokens. Configurable in `MEMORY_SYSTEM` constant.
- **Offline (Desktop)**: llama.cpp bundled; app runs model locally if Claude API unavailable.

---
project: pixip
---

Switching between sessions still rebuilds the transcript DOM from the cached entries, so the text is not truly instantaneous even though parked sockets avoid the WebSocket handshake. Retain a per-session transcript pane (DOM plus scroll/expanded state) as a hidden virtual-tab layer, with a later path to full per-session client state. Hold implementation until the owner settles the related UI-design ideas.

### Context

`closed/05-park-live-sockets.md` made switching reuse a warm socket and repaint from `sessionCache` before network work. The remaining pause is local: `restoreCachedSession()` calls `renderTranscript()`, which runs `callsFromEntries()`, `htmlOf()`, an `innerHTML` assignment, tool re-tracking, then chunked fill via `setTimeout`. On a phone that work is visible even though no bytes are fetched.

Discussion on 2026-11-23 compared three options:

- **Retained panes (recommended first step):** keep the actual stable transcript DOM per warm session, detach it on switch-away, move it back on return, restore `scrollTop`, rebuild `state.tools`, then send `resume`. Resume deltas append only unseen entries instead of re-rendering the window.
- **Full per-session tab state:** each session gets its own state and UI context, hidden when inactive. Cleaner long-term and aligned with the out-of-scope background-event/per-session-state ticket, but it touches nearly every client module.
- **HTML-string cache:** store `ui.log.innerHTML` and restore it. Easiest, but still reparses HTML and rebuilds layout, so it does not remove the main cost.

### Scope

- Add a `sessionPanes`-style manager keyed by session id, with the same lifetime as the warm sockets: active plus up to two parked, LRU-evicted.
- Retain stable transcript DOM and scroll position; keep expanded tool details and images where possible.
- Discard or reconcile volatile DOM (streaming assistant tail, optimistic user block, thinking indicator) on park; let the resume delta/live events repaint it.
- Resume should append unseen entries to a retained pane, not call the full `renderTranscript()` path.
- Drop the pane on socket eviction, rekey, compaction, or a `replace` snapshot.
- Keep the dashboard and protocol unchanged.
- This is a hidden-tab mechanism: no user-visible tabs are required.

### Open design questions

- The owner has UI-design ideas around switching and the desktop/session surface; settle those before choosing the final pane shape.
- Full transcript DOM per pane vs only the visible slice plus a margin; measure memory on a phone.
- Whether panes should become full `SessionView` state objects immediately or stay a DOM-only optimization first.
- How much volatile/optimistic state to preserve versus rebuild from the resume snapshot.

### Draft acceptance

- Switch away and back shows the retained transcript within the same frame, with no full entry-to-HTML render on the return path.
- No new WebSocket and no extra network work for the text paint.
- Scroll position, expanded tool details and loaded earlier windows survive the switch.
- Active plus two parked panes are bounded; eviction/rekey/daemon restart drops panes cleanly.
- Browser bench asserts the return path skips `renderTranscript()` and records click-to-paint at 390 and 1280.
- Unit coverage for pane LRU, rekey, eviction and append-only resume application.

### Files

Likely `src/client/transport.js` (pane lifetime alongside sockets), `src/client/session.js`, `src/client/frames.js`, `src/client/transcript.js`, `src/client/transcriptWindow.js`, `src/client/kernel/state.js`/`ui.js`, `test/`, `tools/browser-check.mjs`, `tools/reconnect-bench.mjs`, `ARCHITECTURE.md`.

### Out of scope until decided

- User-visible tabs or a tab bar.
- Background event application for hidden sessions.
- A framework or bundler; the client stays vanilla.
- Multiplexed sockets, warm child pools, or Pi changes.

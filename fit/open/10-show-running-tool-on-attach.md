---
project: pixip
---

Attaching to a session while a tool is running shows no running-tool card, because the snapshot carries no in-flight tool and the original `tool_execution_start` predates the socket. Replay unresolved tool starts on attach/resume so the current call (name, args, live output) is visible instead of a silent busy transcript.

### Symptoms

Switching into the worktree session while its `bash` ran `npm run check` (~6 min) showed nothing happening: no tool card, no output, just a busy session. It looked hung even though tests were running.

### Root cause

- Live: `tool_execution_start` creates the card (`src/client/transcript.js`), and `tool_execution_update`/`tool_execution_end` fill it in.
- Attach/resume: the snapshot only paints completed JSONL entries; `htmlOf` renders assistant messages with `includeTools=false`, and a running call is not yet an entry. The hub only buffers events from subscription time (`src/server.ts` attach), so a start that happened before the attach is not replayed.
- The later `tool_execution_end` finds no card in `state.tools` and is dropped, so even the result does not appear until a new snapshot/delta lands.

### Scope

- Show the currently running tool(s) after attach, park/resume, reconnect and daemon reattach for a live session.
- Prefer the server seam: remember unresolved `tool_execution_start` raw frames per `LiveSession` and replay them after the snapshot, with the live subscription already in place. Keep frames verbatim (no parse/re-encode), no wire-version change.
- Alternative to grill: derive running calls client-side from the last assistant `toolCall` entries with no matching `toolResult` — acceptable only if it cannot duplicate cards.
- Handle multiple simultaneous tools, tools that end during the attach, and stopped sessions (no phantom "running" card once no child is live).
- Keep `09-background-session-state`'s deliberate muting of busy parked sessions: this is about the active view after waking/attaching.

### Acceptance

- Attaching mid-`bash` shows the tool card with its name and summarized args on the first paint, then streams partial output and the final result.
- `tool_execution_end` for a replayed card updates that card instead of being dropped.
- No duplicate card for the same `toolCallId`, whether the attach races the start, the result or the `end`.
- A stopped/idle session never shows a card for a tool that is no longer running.
- Existing live tool rendering is unchanged when the client is already attached before the start.

### Tests

- Hub test with a fake backend: emit `tool_execution_start` with no `end`, attach a second client, assert the raw start frame is replayed once before/with the snapshot; then emit `end` and assert the card-updating frame is delivered.
- Race tests: start during attach, end during attach, result already covered by the snapshot.
- Pure/browser check for the rendering path (390 and 1280) with a running tool card.
- `npm run check` green.

### Constraints

- Do not change the wire protocol shape or bump `WIRE_VERSION`; replay existing frame types.
- Keep the Rust-port boundary: a small per-session map of unresolved tool frames is fine, re-encoding is not.
- No client bundler/build step; keep `render.js` pure where possible.
- Event -> frame stays in the same tick; replay is bounded by the number of concurrently running tools.
- Do not touch provider latency or the model path.

### Related

- `closed/05-park-live-sockets` (parked sockets, no handshake), `open/09-background-session-state` (busy sessions stay muted while parked; explicitly prefers the resume delta), `closed/05-stale-pi-session-env`.

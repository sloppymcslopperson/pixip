---
grilled: true
---

Thoughts should stream. By default, "agent is thinking" messages should do like they currently do (albeit they should be made to survive reconnects), but if a user clicks the message it should expand into a streaming thought message.

### Decisions

- **Default:** the existing transient `agent is thinking…` indicator is unchanged in placement and lifecycle. It is inert and plain text until the current assistant message has thinking text.
- **Expand:** once thinking text exists, the indicator becomes a native disclosure (`<details>`) with a visible marker and the same summary label while deltas arrive. Tapping toggles it open/closed and is keyboard accessible.
- **Labels:** summary stays pulsing `agent is thinking…` while thinking deltas are arriving; after `thinking_end` (assistant text still streaming) it becomes plain `thinking` with no pulse, and keeps its body until `message_end`.
- **Live body:** streamed thought text uses the same ANSI rendering as the final box. Updates are batched on a rAF, and follow the newest text only while the reader is already pinned to the bottom.
- **No thinking:** if the model/provider emits no thinking text, the indicator stays exactly as today and never becomes clickable.
- **One box:** all thinking blocks of one assistant message render as a single `details.think` box, live or from a snapshot. If the live box was open at `message_end`, the final box for that assistant message starts open; otherwise it starts collapsed.
- **Multi-block / multi-message:** thinking blocks inside one assistant message are concatenated. Once the user expands a live thought, later assistant messages in the same turn (for example after a tool result) also stream expanded.
- **Reset:** expansion resets at `agent_start` of a new turn and at `agent_settled`; it is not persisted to the device.
- **Reconnect:** the collapsed indicator survives a reconnect. In-progress thought text also survives a socket reconnect and a full page reload: the hub keeps a volatile, per-session buffer for the current assistant message and the server sends one derived `live_thinking` frame after the snapshot. A reload starts the restored thought collapsed; same-page reconnects preserve the current open/closed choice.
- **Completed thoughts:** only in-progress assistant messages use the live replay path. Finished thinking comes from the normal snapshot and its final box is collapsed unless the live box was open at the switch.
- **Hub buffer:** memory only, never written to disk. It is capped at ~256 KB per session, keeps the newest text silently, and clears at `message_end`, `tool_execution_start`, or `agent_settled`. The hot path still forwards Pi records verbatim; only the attach path uses the derived frame. A monotonic thinking sequence number prevents the snapshot/subscribe buffer from replaying deltas already folded into the derived frame.

### Scope

- Client: live thought state, disclosure indicator, thinking delta handling, final single thinking box with preserved open state, CSS.
- Hub/server: volatile live-thinking buffer, derived `live_thinking` attach frame, sequence filtering against the existing subscribe buffer.
- Docs/tests: update the render test for one thinking box, add pure reducer tests and an attach-path integration test.

### Acceptance

- Before any thinking text arrives, `agent is thinking…` behaves as it does today and cannot be expanded.
- Once thinking text arrives, tapping the indicator expands a live streaming thought; tapping again collapses it.
- The final assistant block shows one thinking box; it is open when the live box was open at `message_end`, otherwise collapsed.
- A reconnect during an active thought restores the collapsed indicator plus the thought text; a full page reload does the same.
- No thinking text means no disclosure and no error.
- `npm run check` green, and `tools/shot.mjs` at 390 and 1280 for the live expanded thought.

### Files

- `src/client/transcriptView.js`, `src/client/transcript.js`, `src/client/render.js`, `src/client/frames.js`, `src/client/kernel/state.js`, `src/client/transcript.css`.
- `src/liveThinking.ts` (pure hub reducer), `src/hubLive.ts`, `src/hub.ts`, `src/hubSession.ts`, `src/wire.ts`, `src/server.ts`.
- `test/liveThinking.test.ts`, `test/thinkingStream.test.js`, `test/render.test.js`, `test/live-cursor.test.ts`.
- `ARCHITECTURE.md`, `README.md`.

### Tests

- Pure hub reducer: start/delta/end aggregation, multi-block separators, active flag, monotonic sequence, cap keeps newest, clear.
- Pure client reducer: separators, deltas, end, reload text replacement.
- Render: multiple thinking blocks become one box; `open` option.
- Attach integration: a thought streaming during the snapshot produces one `live_thinking` frame and no duplicated buffered deltas.
- Browser/screenshot at 390 and 1280 with an expanded live thought.

### Constraints

- Keep events on the live path verbatim; the hub buffer is derived state for reattach only, in memory only.
- No new dependency, bundler or framework; client modules stay plain JS.
- No `#log`-nested scroll container: the live thought body grows inside the existing transcript scroll.
- Do not change Pi or add a shim/extension hook; thinking events already arrive as `message_update` with `assistantMessageEvent`.

### Implementation

- `src/client/thinkingStream.js`: pure live-thought reducer (`thinking_start`/`delta`/`end`, block separator, reattach frame preserving the tab's open choice).
- `src/client/transcriptView.js`: plain indicator until text exists, then a native disclosure; rAF paint; summary switches from pulsing `agent is thinking…` to `thinking`; toggle updates the turn's open state.
- `src/client/transcript.js`: tracks `state.liveThought`, resets it per assistant message while keeping expansion for the turn, handles thinking events and `live_thinking`, and marks the final thinking box open when the live box was open.
- `src/client/render.js`: one combined `details.think` per assistant message, with an `openThinking` option.
- `src/liveThinking.ts`: volatile hub buffer keyed by content index, 256 KB newest-first cap, monotonic sequence, clear on message/tool/agent boundaries.
- `src/hubLive.ts` / `src/hub.ts`: `liveThinking(id)` and per-thinking-event sequence stamping on the forwarded frame; `src/server.ts` flushes non-thinking frames, then sends one `live_thinking` frame, then only deferred thinking deltas newer than that sequence.
- `src/wire.ts`: `frameLiveThinking`; `src/client/frames.js` handles it after snapshots.
- `src/client/transcript.css`: disclosure styling and the live body inside the normal transcript scroll.
- `ARCHITECTURE.md` and `README.md` document the live-thinking path and memory-only buffer.

### Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:imports`: green.
- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm test`: 399 tests, 399 pass, 0 fail.
- `npm run check --workspace pixip-pi-host`, `pixip-questionnaire`, `pixip-show-image`: green.
- `npm run check:browser`: skipped here because `PIXIP_CHROME` is unset and no Chrome/Chromium binary is installed on this box. `tools/shot.mjs` at 390/1280 could not be run for the same reason; the client change is CSS/DOM-only and keeps `#log` as the only scroll container.

### Post-rebase verification (Chrome available)

- Rebased onto `origin/master` (`52481a6`), resolving conflicts with the compaction indicators in `transcript.js` / `transcriptView.js`.
- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm test`: 405 tests, 405 pass, 0 fail.
- `PIXIP_CHROME=/home/sloppy/.agent-browser/browsers/chrome-158.0.8127.88/chrome npm run check:browser`: 2 viewports passed (390x844 and 1280x900), no page/console errors or horizontal overflow.
- Feature screenshots at 390 and 1280 for collapsed and expanded live thought were captured with headless Chrome; no layout overflow.

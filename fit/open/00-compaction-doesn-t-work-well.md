---
project: pixip
---

Compaction does not work well: after `/compact` the history the client holds is only patched by a blanket `resnapshot`, and while a compaction runs the UI shows a 3.2 s toast and nothing else. It should adopt the post-compaction history precisely and keep the user informed of progress for as long as compaction lasts.

### Symptoms

- `/compact` feels like a no-op: a short toast appears and disappears, the composer stays live, and nothing marks the session as compacting.
- The compacted transcript only appears once `compaction_end` arrives; the compaction entry is not on the live event path, so a client that attaches mid-compaction sees nothing.
- History handling is coarse: every connected client sends `resnapshot`, which replaces all loaded windows, resets scroll, and can race the pending optimistic user message / streaming card. `compaction_end.aborted` is ignored, so a failed compaction still replaces the transcript.
- The footer's context percent/window only refreshes in the tab that issued `compact` (`hubSession.compact` -> `sendFooter`); other tabs and auto-compaction rely on later events.
- A compaction that stalls leaves `compact` waiting forever (`timeoutMs: 0`) with no user-visible state, and a second `/compact` or prompt can be sent underneath it.

### Current path

- Client: `composer.compact` sends `{t:"compact", instructions?}` (`src/client/composer.js`); `transcript.handleEvent` shows `toast("compacting (reason)…")` on `compaction_start` and sends `resnapshot` on `compaction_end` (`src/client/transcript.js`, `src/client/sessionEffects.js`, `src/client/app.js`).
- Server: `server.ts` case `compact` awaits `hub.compact`; `hubSession.compact` awaits the RPC response with `timeoutMs: 0`, then `sendFooter`. `resnapshot` returns a `snapshot` with `replace: true` (`src/wire.ts` `frameSnapshot`).
- Events: `compaction_start`/`compaction_end` are forwarded verbatim by `hubLive.onLine` through the `default` branch; no status/footer bookkeeping is done for them.
- Nothing on the wire carries `isCompacting` (Pi exposes it through the host protocol, `pi-host/src/protocol.ts`), so the dashboard and other tabs cannot show compaction state.

### Scope

- Adopt the post-compaction history deterministically on `compaction_end` (no matter which tab asked, and also for auto-compaction), without losing scroll anchoring in a way the user notices, and without dropping a message the user just sent.
- Skip or repair the replace when `compaction_end.aborted` is true, and when the snapshot request fails.
- Show compaction as a durable session state, not a toast: visible on the session header/footer (and on the dashboard session card) from `compaction_start` until the post-compaction snapshot is adopted, so a client attaching mid-compaction still shows it.
- Report progress while it runs. Decide what is honest: the elapsed time and the pre-compaction context size are known (`tokensBefore` on the RPC result, `contextUsage` in the footer), mid-compaction token estimates are not. Pi's RPC has no compaction-progress stream, so do not invent one; a live "compacting… Ns" marker plus the final `tokensBefore` -> `estimatedTokensAfter` result is acceptable.
- Keep the composer usable-by-choice or disable it during compaction, but make the decision explicit and consistent with how the hub marks `busy` sessions.
- Consider making `compact` not hold the request open for the whole run: fire the command, mark the state from `compaction_start`, and let `compaction_end` clear it. Preserve a real timeout/error surface for a compaction that never ends.

### Acceptance

- Hitting `/compact` immediately marks the session as compacting in every attached tab and on the dashboard, and that marker survives a client attach/reload mid-compaction.
- The marker clears when compaction finishes or aborts, and states the outcome (compacted with before/after token counts, or aborted/failed).
- The transcript after compaction shows the compaction entry and the kept tail exactly once, with no duplicate compaction block after a reconnect, and a second tab that did not issue the command ends up in the same state.
- An aborted or failed compaction leaves the pre-compaction transcript intact and says so.
- A `/compact` with instructions still reaches Pi as `customInstructions` and the footer's context percent/window updates in every tab.
- Auto-compaction shows the same state, at least as a non-blocking marker.
- No regression in the existing built-in test's `replace` snapshot contract.

### Tests

- `npm run check` green.
- Hub test with `test/fixtures/fake-pi.mjs`: `FAKE_PI_COMPACTION=0` (no start/end) exercises the timeout/error path; the existing `compaction_start`/`compaction_end` fixture covers the happy path. Add an aborted `compaction_end` case.
- Assert the compaction state frame reaches a second client that attaches after `compaction_start`, and that it is cleared after `compaction_end`.
- Pure client test for the state -> label mapping and the history-replace decision (apply/keep) in `render.js`/`sessionEffects.js` style.
- `tools/shot.mjs` at 390 and 1280 with a compacting session, and a post-compaction transcript.

### Constraints

- Keep frames verbatim and the Rust-port boundary: prefer a small explicit state frame or an existing `status` field over parsing Pi records.
- No bundler or framework; `render.js` stays pure.
- Do not change how Pi compacts or its summary prompt; this is UI/state handling only.
- Latency budget unchanged for the normal event path; a compaction marker update may not delay `agent_start`.
- If `ARCHITECTURE.md`'s compact/resnapshot row or the built-in command table changes, update it there.

### Open questions

- Is the desired history behaviour "replace everything with the fresh snapshot", or "keep the loaded pre-compaction windows above the new compaction entry" (the current `replace` drops them)?
- Should the composer be disabled while compacting, and should a queued prompt wait for compaction?
- How much progress is expected: elapsed-seconds marker only, or also a pre/post token delta and an ETA from `tokensBefore`?
- Should compaction notices appear in the transcript itself (a meta block) as well as the header?

### Related

- `closed/00-question-panel-disappearing` (blocking UI while detached), `open/09-background-session-state` (per-session state while parked), `open/10-show-running-tool-on-attach` (the same attach/replay gap for tool cards), `ARCHITECTURE.md` "Built-in slash commands".

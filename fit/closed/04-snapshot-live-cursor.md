---
grilled: true
commit: "920082c1520522ec03a54d48a85d8570d8804f9c"
---

Entries that arrive between `get_entries` and the subscription are lost, so a client connecting mid-turn can miss the start of a message. Subscribe first, buffer, and reconcile with Pi's durable entry cursor.

### Goal

No lost or duplicated entries across the snapshot/live boundary, using Pi's durable entry cursor.

### Done when

- The socket subscribes before requesting the snapshot and buffers live frames meanwhile.
- After the snapshot, buffered frames are flushed; anything already covered by the snapshot is dropped by comparing against `leafId` and message identity.
- On reconnect, an existing transcript can resume with `get_entries` and `since: <leafId>` instead of a full re-send (server side), proven by a test with a fake RPC peer.
- `npm run check` passes; no change to the wire version unless the frame shape actually changes.

### Decisions (grilled 2026-11-21)

- Order: `attach` -> `hub.subscribe` (server buffers) -> `hub.snapshot`; flush after the snapshot frame. Per-socket buffer, so a second phone connecting mid-turn gets the same guarantee.
- Identity: RPC events carry no entry id, so the hub (which already parses each record for status) stamps a coverage key and the server filters on it:
  - `message_start` / `message_end` -> `msg:<role>:<message.timestamp>`;
  - `message_update` -> `msg:assistant:<tracked assistant timestamp>`;
  - `tool_execution_*` and `turn_end` -> `msg:assistant:<last assistant timestamp>` (the tool call belongs to that assistant message);
  - everything else (`agent_*`, `session_info_changed`, `thinking_level_changed`, `extension_ui_request`, compaction/retry, errors) has no key and always flushes.
- Coverage: one `msg:<role>:<message.timestamp>` per snapshot entry that has a `message`; a buffered frame whose key is covered is dropped. Consequence: a covered assistant message's buffered `tool_execution_start` is dropped too, so its tool block appears when the toolResult entry arrives rather than at execution start. No duplicate, no data loss.
- Buffer cap: 2 MB or 2000 frames, whichever comes first. On overflow, entry-bearing buffered frames are discarded and, after the snapshot, `get_entries {since: snapshot.leafId}` (windowed to the usual 200) is sent as a second snapshot; non-entry buffered frames still flush.
- Resume: the WS URL gains `&since=<lastEntryId>`; the server replies with a normal `snapshot` carrying only the delta plus additive `resume: true`; an unknown cursor (`Entry not found`) falls back to a full snapshot. `WIRE_VERSION` stays 1.
- Client: sends the cursor only when entries for that session are already in memory (wake/network reconnect), never on a fresh open. On `resume: true` it appends entries missing by id, keeps the current `more`, and repaints from `state.entries`; live-painted DOM is replaced by entries, so nothing duplicates and nothing is lost.
- Tests: WS integration only (fake pi + real `ws` client) - a record emitted between `get_entries` and subscribe appears exactly once; a `since` resume sends only the delta; an unknown cursor falls back to a full snapshot.
- The provisional pre-attach snapshot is unchanged; the authoritative snapshot still replaces it.

### Files

`src/server.ts` (subscribe/buffer/snapshot order, `since` parsing, `opened`-style id handling untouched), `src/hub.ts` (coverage keys, `get_entries` with `since`), `src/wire.ts` (`resume` flag), `src/client/app.js` (cursor + reconcile path), `test/` (fake pi fixture and live-cursor integration test).

### Notes

- Never parse and re-encode an event on the path to the socket: keep forwarding the original string, and read identity fields only for the coverage key (the hub already parses the record for state bookkeeping).
- Pi appends an entry before/with emitting its event, so every entry whose event was emitted before `get_entries` is in the snapshot; coverage keys are therefore sufficient.
- No ARCHITECTURE.md change in this ticket (the open question stays for a later docs pass).

### Verification

- `npm run check` green: `tsc --noEmit` plus 60 tests (4 new in `test/live-cursor.test.ts`, real `ws` client against `startServer` on port 0 with the fake Pi peer).
- New tests: a record emitted inside the `get_entries` window whose entry is in the response is dropped exactly once (the snapshot is the only copy); a record emitted inside the window whose entry is *not* in the response is flushed exactly once; `?since=e1` returns a `resume: true` snapshot containing only `e2`/`e3` and skips the provisional paint; an unknown cursor logs a rejection and falls back to a full snapshot with no error frame.
- Real-Pi smoke on a copied session: `?session=<id>&since=<entry>` produced `resume: true` with only the 3 entries after the cursor, and `since=deadbeef` produced a full 9-entry snapshot after `resume cursor deadbeef rejected (Entry not found: deadbeef)`. No wire version bump.
- Client screenshots could not be taken: no working Chromium on this box (both `/tmp` headless shells fail on `libatk`/`libgbm`, no sudo), so `tools/shot.mjs` at 390/1280 was skipped; `node --check src/client/app.js` passes. The client change is the cursor in the WS URL plus `renderResume` (append + repaint, no layout/CSS). Please re-run the shots where Chromium is available.

### Implementation notes

- `hub.subscribe()` now hands subscribers `(frame, key?)`; the hub stamps the key in `onRecord` (it already parsed the record for status) and forwards the original string untouched. `LiveSession.assistantTs` tracks the current/last assistant message so `message_update`/`tool_execution_*`/`turn_end` can be attributed.
- `hub.snapshot(id, limit, since?)` sends `get_entries` with the cursor and returns `covered` computed over the **full** response (not the 200-entry window), so a buffered record for an older entry is still dropped.
- `src/server.ts` buffers entry-bearing frames per socket while `get_entries` is in flight, sends the snapshot, then flushes non-covered frames. Records without a key (status, `session_info_changed`, extension UI, errors) are sent immediately, so dialogs are never delayed by the buffer.
- Overflow (>2 MB or >2000 buffered frames) discards the entry frames and closes the gap with `get_entries {since: leafId}` as a `resume: true` snapshot; the loop is bounded to three passes, after which live frames simply continue. Non-overflowing buffers are flushed with exact coverage.
- `requestSnapshot()` treats a rejected cursor as "forked/compacted/bogus" and falls back to a full window; `WIRE_VERSION` stays 1 because the `resume` field is additive.
- Client: `socketUrl()` adds `&since=<last entry id>` only when `state.sessionId` already matches and `state.entries` is non-empty (wake/auto-reconnect, never a fresh open); `renderResume()` appends entries missing by id, keeps `state.more`, and repaints from `state.entries`, so live-painted blocks are replaced by their entries.

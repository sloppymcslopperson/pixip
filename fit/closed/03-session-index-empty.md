---
grilled: true
commit: b7093d6af39072526b170f7ef09ed6e22901de1f
---

Pi writes the session JSONL on the first message, so a session created and detached without a prompt disappears from the list. Keep a small merged index beside the session dir, and give every spawned session a stable pixip logical id.

### Goal

A session that has never been prompted still appears in the list after it is detached or after the hub restarts. Every spawned session also keeps a stable pixip logical id that survives Pi allocating a new session id.

### Done when

- `<data-dir>/sessions.json` (explicit `HubOptions.indexPath`; `bin/pixip.ts` passes it) is a plain JSON array, written atomically (temp file + rename) and merged by logical id, never overwritten.
- Every spawn generates a `logicalId` (`crypto.randomUUID()`), passes it to the child as `PIXIP_SESSION_ID`, and persists `{logicalId, piId, piIds, cwd, name?, sessionFile?, createdAt}` right after `get_state`.
- `list()` reads the index; JSONL wins for state, name and last activity when both exist, and the record's `logicalId` is merged onto the JSONL entry by Pi id.
- An index-only record lists as `state: "stopped"`, `lastActivity = createdAt`, `sessionFile` from the record, plus the additive `SessionInfo.logicalId`.
- Opening an index-only session reattaches at the recorded `sessionFile`: Pi allocates a new Pi id, the record's `piId`/`piIds` are updated, and the socket tells the client the new id with `opened`.
- Renames of a session with no JSONL are persisted.
- Deleting the index loses only empty-session listings; JSONL sessions, live sessions and the rest of the hub keep working.
- `npm run check` passes; `test/` covers index-only, JSONL-only, both, corrupt index, merge preservation, reattach-with-new-id, and `PIXIP_SESSION_ID`.

### Decisions (grilled 2026-11-21)

- Path wiring: explicit `indexPath` in `HubOptions`; `bin/pixip.ts` passes `<data-dir>/sessions.json`. No `dirname(sessionsDir)` guessing.
- Record shape: `{logicalId, piId, piIds: string[], cwd, name?, sessionFile?, createdAt}`; newest Pi id last in `piIds`. Records are keyed by `logicalId`; lookup accepts any `piId` or a `logicalId`.
- Logical id: `crypto.randomUUID()`, generated at spawn, passed as `PIXIP_SESSION_ID` (needs an `env` field on `RpcChildOptions`). Wire/URL routing stays on Pi's id.
- Retention: logical records are kept after the JSONL appears (supersedes the earlier "prune when JSONL exists" answer) so the logical -> Pi id mapping survives restarts. No pruning in this ticket.
- Index-only open: spawn `pi --session <recorded sessionFile>` in the recorded cwd. Verified: Pi allocates a *new* session id at that path and writes the file on the first prompt, so the hub follows the new id and replaces the record. The client adopts the new id from `opened` and rewrites the hash without re-clearing the view.
- Missing `sessionFile` in a record: fall back to a fresh spawn in the recorded cwd with the recorded name and replace the old record.
- Renames: `session_info_changed` updates the index name only while `info.sessionFile` does not exist; the JSONL keeps winning afterwards.
- Provisional paint for an index-only id: return an empty `starting` snapshot built from the index record instead of throwing, so the phone paints before the child boots.

### Files

`src/hub.ts` (index read/write, spawn, list, scan, provisional/attach), `src/rpc.ts` (env passthrough), `src/wire.ts` (`logicalId`), `src/server.ts` (`opened` on id change), `src/client/app.js` (adopt id), `bin/pixip.ts` (`indexPath`), `test/` (`test/fixtures/fake-pi.mjs` plus index/list/reattach tests).

### Notes

- Writes are serialized in-process and atomic (temp file + rename); no lock file at prototype scale.
- Corrupt or missing index: log and continue with an empty index; list still serves JSONL and live sessions.
- Tests use `test/fixtures/fake-pi.mjs` (JSONL RPC over stdio) as `piBin`, never the real Pi.

### Verification

- `npm run check` green: `tsc --noEmit` plus 56 tests (7 new in `test/index.test.ts`).
- New tests cover index-only after detach + restart, JSONL-only, both (JSONL wins for name/activity, index adds `logicalId`), corrupt index, merge without clobbering, reattach-at-path under a new Pi id, rename persistence and `PIXIP_SESSION_ID`.
- Real-Pi smoke on a scratch `--data-dir`: create → index record written (`logicalId`, `piId`, `piIds`, `sessionFile`); stop; restart; the empty session still lists as `stopped` with its name; opening it over the socket produced `snapshot(starting, 0 entries)` → `opened(<new piId>, same logicalId)` → `snapshot(idle, 4 entries)` and the record's `piIds` gained the new id. No JSONL was created by Pi, confirming the premise.
- Client screenshots could not be taken: this box has no working Chromium (both headless shells under `/tmp` fail on missing `libatk`/`libgbm` and there is no sudo), so `tools/shot.mjs` at 390/1280 was skipped. The client change is the `opened` branch only (adopt the new id with `history.replaceState`, no layout), and `node --check src/client/app.js` passes. Please re-run the shots where Chromium is available.

### Implementation notes

- `HubOptions` gained `indexPath` (required, passed by `bin/pixip.ts`) and an optional `env` for test seams; `RpcChildOptions` gained `env`, merged after `process.env`.
- Index writes go through one serialized read-modify-write chain (`mutateIndex`), so concurrent spawns cannot drop each other; writes are temp-file + rename. A corrupt index is logged and treated as empty.
- `list()` keeps the JSONL first and only merges `logicalId`; index-only records use `createdAt` as `lastActivity` and are skipped when any of their Pi ids is already live or on disk.
- `provisional()` returns an empty `starting` window for an index-only id (instead of throwing), so the phone paints before the child boots.
- `src/server.ts` tracks the resolved id per socket (`activeId`) and sends `opened` when attach lands on a different Pi id; every later command (prompt/stop/earlier) uses the new id.
- Renames persist only while the JSONL does not exist (`exists` check before the index write); the JSONL keeps winning afterwards.

---
project: pixip
---

Archiving a session can leave its Pi child running against a moved session file, and a later session can reuse the archived `logicalId`. Make archive/delete terminate or detach every child for the logical session and keep logical ids unique across active and archived records.

### Symptoms

Observed on the live `tmp/trial` daemon:

- `tmp/trial/archive/6bcdf785-fa44-4471-8f31-8258d615bac5-2073a19d/meta.json` has `logicalId: 6bcdf785…`.
- `tmp/trial/sessions.json` also has an active session with `logicalId: 6bcdf785…`.
- pid 305863 is still alive with `--session` pointing at the archived (moved) `01a20b50…jsonl`.

### Root cause

- `src/hubStore.ts` `storeSession()` relies on `findLive()` + `stop()`; a child that is parked or missing from the live map survives archive.
- Adjacent paths (`attach`, `restoreStored`, index-only reattach) can create/update an active record without checking whether the id already exists under `archive/` or `trash/`.

### Scope

- Make archive/delete terminate or definitively detach any child belonging to the target `logicalId` before moving files and removing the index record, including a child that was parked or missing from the live map.
- Make logical ids unique across active and archived records: never create a new active record with an id that exists in `sessions.json`, `archive/*/meta.json`, or `trash/*/meta.json`.
- Audit `restore` so restoring an archived record cannot collide with a new active record that reused its id.

### Acceptance

- `pixip archive` (and delete) leaves no child process for the archived session, even if it was parked; the archived file is no longer held by a process.
- A new session never reuses a `logicalId` present in `sessions.json`, `archive/*/meta.json`, or `trash/*/meta.json`.
- Archive then create, and archive then restore, both produce distinct logical ids and a clean list.
- Existing worktree create/attach/remove flows and peer grouping keep working.

### Tests

- Hub test: archive a session with a live fake backend, assert the backend is closed and the session lists as stopped.
- Hub test: archive then create, assert the new `logicalId` differs from the archived meta id.
- Hub test: archive then restore plus a concurrent create, assert no duplicate logical id.
- `npm run check` green.

### Constraints

- Do not change the wire protocol or client assets.
- Keep archive/trash files on disk recoverable; this is lifecycle correctness, not a format change.
- Do not touch the model-provider latency issue; that is upstream `opencode-go` and is out of scope here.
- The stale `PI_SESSION_FILE`/`PI_SESSION_ID` leak is a separate ticket (`05-stale-pi-session-env`), not this one.

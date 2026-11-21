---
grilled: true
---

Add session archive, restore, and delete to the dashboard, plus an "archive all inactive" bulk action. Archive hides a session but keeps it recoverable; delete stages the files for a short undo window, then purges them permanently.

### Decisions

- **Archive** moves the logical session's JSONL files and index metadata to `<data-dir>/archive`; the active session scan never sees them. Archive persists until restored or deleted.
- **Delete** removes all JSONL files tracked by the logical session's `piIds` and its `sessions.json` record, keeping generated exports. It moves them to `<data-dir>/trash` first for the undo window.
- **Undo:** delete confirmation is followed by a ~10 s undo toast. The hub keeps trash for 60 s, then purges; leftover trash is purged on startup. Trash is also visible in settings with restore/purge.
- **Archived view:** settings shows `archived (N)` and `trash (N)` entries; each opens a sheet listing sessions with restore and permanent delete/purge actions.
- **Bulk:** "archive all inactive" (whole dashboard) means every stopped session across all cwd groups, including index-only sessions, excluding already archived/trashed ones. It continues on per-session failures and reports archived/failed counts.
- **Live sessions:** single-session archive/delete of an idle session first detaches the child; busy/starting sessions are refused. If stopping fails or the state changes to busy, skip that session and leave files intact. Bulk only considers stopped sessions.
- **Open tabs:** archiving/deleting a session that another tab has open returns that tab to the dashboard with a toast.
- **Restore:** preserves logical id, name and cwd; a colliding JSONL path gets a unique filename instead of failing.
- **UI:** per-row actions menu plus a dashboard "archive inactive" control. Single actions use the in-app sheet for confirmation; bulk uses a native confirm. Errors and undo use the existing toast.
- **Transport:** REST endpoints parallel to `POST /api/sessions/:id/stop`; the dashboard refetches `/api/sessions` afterwards. No new websocket frames.

### Acceptance criteria

- Archiving a stopped/idle session removes it from the active dashboard and its files from the active sessions store.
- Restoring an archived session returns it to the dashboard under its original cwd/name/identity.
- Deleting a session asks for confirmation, removes it from the dashboard, offers undo for ~10 s, and permanently purges after 60 s or on next startup.
- "Archive all inactive" archives every stopped session, skips busy/live ones, and reports counts.
- Busy sessions cannot be archived or deleted.
- `npm run check` is green and `tools/shot.mjs` is run at 390 and 1280 for the dashboard and dialogs.

### Implementation

- `src/hub.ts`: archive/trash move helpers, `meta.json` per stored session, restore with collision-safe paths, bulk stopped-only archive, startup trash purge, 60 s auto-purge, list/restore/purge APIs.
- `src/server.ts`: REST routes for archive, archive-inactive, delete, archived/trash lists, restore and purge.
- `src/client/app.js` + `style.css`: row actions menu, confirm sheets, bulk archive control, settings archived/trash sheets, delete undo toast, open-tab removal handling via the existing `sessions` frame.
- `test/archive.test.ts`: archive/restore, delete/undo/purge, auto-purge, bulk and busy refusal, plus the REST route surface.
- `ARCHITECTURE.md` and `README.md` document the storage layout and endpoints.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check`: 180 tests pass. (The ambient `PIXIP_INSIDE=1` makes the pre-existing daemon tests expect a restart instead of a stop.)
- `tools/shot.mjs` at 390 and 1280: no horizontal overflow, no console/page errors; dashboard rows, actions sheet, settings archived/trash and restore flow exercised in headless Chromium.

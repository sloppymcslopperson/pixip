---
grilled: true
commit: cf103a178222e844af4af6c0ea78a372c2c6f509
---

Reopening a session the SPA has already viewed should paint its transcript immediately from an in-memory per-session cache, restoring the previous scroll position instead of flashing an empty “connecting…” view. Cache up to eight recently viewed sessions; a new tab or full reload keeps today’s provisional path.

### Scope

- Client-only, in-memory cache keyed by session id (and logical id where available).
- Populated whenever a session transcript is painted; used by `openSession` before the websocket snapshot arrives.
- LRU bound of 8 sessions, dropped on archive/delete and on page reload.

### Decisions

- “Hot” means a session with a live child or any session this SPA has recently viewed in this page.
- Preserve the transcript window plus scroll position; if the user was pinned to the bottom, stay pinned and let live deltas append normally.
- Keep the per-session composer text and queued chips when returning to a cached session.
- New tab/full reload is out of scope: it falls back to the existing JSONL provisional path, and a live session may briefly show the connecting state.
- No hub-side transcript cache and no protocol change.

### Acceptance

- Reopening a cached session shows its entries before the socket snapshot, with no empty transcript flash.
- A scrolled-up user returns to the same reading position; a bottom-pinned user remains pinned.
- Composer draft and queued chips for that session are restored.
- The cache never exceeds 8 sessions and evicts the least recently viewed.
- Archive/delete invalidates the session’s cache entry.
- Unseen sessions and new-session creation behave exactly as today.
- Authoritative snapshots and live deltas still dedupe by entry id, so cached entries are never painted twice or lost.

### Files

- `src/client/app.js` (`openSession`, `showList`, snapshot/event paths, cache helper)
- `test/` for the pure cache/LRU helper if extracted

### Tests

- Pure test: LRU eviction, cache hit/miss, and invalidation on archive/delete.
- Client regression: cached open paints entries and restores scroll; snapshot/delta merge does not duplicate.
- `npm run check` green, plus `tools/shot.mjs` at 390 and 1280 reopening a cached session.

### Edge cases

- Session re-keyed by `/new`, fork, clone, or import: invalidate or migrate the old cache entry so the old transcript never appears under the new id.
- Cached while streaming: the snapshot and buffered deltas must reconcile with cached entries without duplication.
- Cached session that has since stopped: paint the cache, then let the normal status/snapshot path correct it.
- Provisional entries with truncated text: a later authoritative snapshot must replace them correctly.
- Loaded `history` windows and the `more` flag remain consistent after a cached repaint.

### Constraints

- Bounded client memory: one current window per cached session, at most 8 sessions.
- Keep `src/client/render.js` pure; cache logic should be testable without a DOM where practical.
- No bundler, no framework, no server/hub changes.

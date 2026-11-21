Pi writes the session JSONL on the first message, so a session created and detached without a prompt disappears from the list.

### Goal

A session that has never been prompted still appears in the list after it is detached or after the hub restarts.

### Done when

- A small index at `<data-dir>/sessions.json` is written at spawn time with `{id, cwd, name, createdAt}` (merged, not overwritten) and read when listing.
- JSONL stays the source of truth when both exist: the file wins for state, name and last activity.
- Deleting the index loses only empty sessions; nothing else breaks.
- `npm run check` passes and a `test/` case covers index-only, JSONL-only, and both.

### Files

`src/hub.ts` (spawn + list + scan), `test/`.

### Notes

- Keep the format a plain JSON array; no lock file needed at prototype scale, but writes must be atomic (temp file + rename).

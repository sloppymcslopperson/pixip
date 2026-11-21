---
grilled: true
leg: tui-parity-1
---

Bring Pi's branch and session commands to the web UI: a read-only tree sheet with a tap-to-fork action on user messages, plus `/fork`, `/clone`, `/import` and `/export`. These commands change the child's session id, so the hub must re-key the live session and the client must follow it.

### Why now

Slice 6 of the TUI-parity leg and the last one needed to develop pixip inside pixip: exploring alternatives and keeping the good branch is the core TUI workflow that AoE users expect. Re-scoped from `backlog/70-session-commands` to the decisions below.

### Done when

- `/tree` opens a sheet built from RPC `get_tree`: indented branch points (user messages first), labels when present, the current branch marked, and per-entry actions "fork from here" and "copy prompt".
- Tapping a user message in the transcript offers the same fork action (a small affordance on the block, not a full hover menu).
- `/fork <entryId>` and the tap action call RPC `fork`; `/clone` calls `clone`; `/import <path>` imports a JSONL into `<data-dir>/sessions/` (copy, preserving the header id and cwd), indexes it and opens it; `/export` calls `export_html` (and offers the JSONL) and the hub serves a download over a new HTTP route.
- After fork/clone/switch, the hub re-reads `get_state`, re-keys the live map, updates the index `piIds`/`piId`, sends `opened` with the new session and a fresh snapshot; the client follows the id without reconnecting (same path as index-only reattach).
- In-session leaf navigation (the TUI `/tree` move) is documented as **TUI-only**: RPC exposes `get_tree` read-only and no navigate command.
- `npm run check` green; `docs/parity.md` marks /tree, /fork, /clone, /import and /export (with the leaf-navigation caveat).

### Decisions (grilled 2026-11-21)

- Tap a user message to fork, plus the tree sheet; no in-place leaf switching (not exposed by RPC).
- Re-key + `opened` + refresh after fork/clone/switch; reuse the re-key helper introduced by `05-builtin-commands` (`/new`).
- `/import` copies into the data dir rather than pointing Pi at a foreign file, so the isolation boundary and the session index stay intact; the source file is never modified.
- `/export` writes the HTML under the data dir and serves it as an attachment; JSONL export is a straight download of the session file.
- Fork/clone cancellation (`cancelled: true`) is a toast, not an error.

### Files

`src/client/app.js`, `src/client/index.html`, `src/client/style.css`, `src/server.ts` (tree/fork/clone/import/export frames + export route), `src/hub.ts` (`tree()`, `fork()`, `clone()`, `import()`, `export()`, re-key), `src/wire.ts`, `bin/pixip.ts` if a CLI flag is needed, `test/fixtures/fake-pi.mjs`, `test/`.

### Tests

- Fake Pi: `get_tree` fixture, `fork`/`clone` changing the id on the next `get_state`, `export_html` writing a temp file, `switch_session`.
- Integration: fork re-keys and emits `opened` + a fresh snapshot; export route returns the file with an attachment header; import copies a JSONL into the data dir and lists it.
- Pure: tree flattening/labeling for the sheet; export filename helper.

### Notes

- `get_tree` returns an array of roots with nested children; orphaned entries can appear as roots — render them, do not drop them.
- Fork returns only `{text, cancelled}`; the new id comes from a follow-up `get_state`, so the re-key sequence must be tested against a moving id.
- Screenshots (390/1280) are the owner's step; note the gap when closing.

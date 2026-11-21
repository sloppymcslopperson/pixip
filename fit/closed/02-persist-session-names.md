---
grilled: true
commit: "9ca46647233cf29a17c8e489046d22d9b794a23b"
---

### Verification

- `npm run check` green: typecheck + 49 tests; new `test/names.test.ts` covers header-only (no name), a name near the top, a rename later in a long file (tail name wins), an empty/null later `session_info` (previous name kept), a truncated final line (name still found) and mtime cache invalidation.
- Six 18 MB fixture sessions: `GET /api/sessions` 17 ms cold, 3–4 ms warm on this 1 vCPU box; only 8 KB head + 16 KB tail per file are read, never the whole JSONL.
- UI at 390 and 1280: stopped sessions list `big session` instead of the id prefix; the header-only fixture still shows `01a1fb3f`; opening a stopped session shows the name while `state: "starting"` (before the child reports `sessionName`). No console errors, no horizontal overflow.

### Implementation notes

- `header()` now derives `name` in the same mtime-cached entry as id/cwd/timestamp: a head pass over the first 20 lines plus a bounded 16 KB tail pass, both parsed with `nameFromLines()` (last non-empty `session_info` wins, unparsable lines skipped).
- `list()` includes `header.name` for stopped sessions; the client already renders `name ?? id.slice(0, 8)`, so header-only sessions are unchanged.
- The provisional snapshot from ticket 01 already carried `header.name`, so the title is right during `starting` too.
- `ARCHITECTURE.md`: one paragraph documenting the bounded name scan and the shared mtime cache.

commit: 9ca4664

---
grilled: true
---

Stopped sessions show their id prefix because the disk scan only reads the JSONL header, while the display name lives in a `session_info` entry.

### Goal

Stopped sessions show the same name they had while live.

### Done when

- The disk scan reads forward, bounded (first ~20 lines), until it finds a `session_info` entry and uses its `name`.
- A session without a name entry still lists by id prefix, unchanged.
- Cost stays negligible: names are cached per file path with the mtime check already used for headers.
- `npm run check` passes and a `test/` case covers header-only, named, and truncated files.

### Files

`src/hub.ts` (`header()` / scan), `test/`.

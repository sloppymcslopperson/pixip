---
grilled: true
commit: "76330554c6ca6dc1174f1249cbd5ae99b1eaec1c"
---

session names should survive the session stopping

### Grilling

- **Repro paths:** `/quit`/stop button and idle detach. Only auto first-prompt labels have been observed; manual `/name` was not tested, but both paths should be covered.
- **Name source:** JSONL stays authoritative, with an index fallback when the scanned JSONL has no `session_info` name. For new stops, ensure the index keeps the live name. Do not rewrite or backfill already-stopped records.
- **Scope:** both explicit stop and idle detach. No schema change, no client-only workaround.
- **Acceptance:** unit tests in `test/index.test.ts` (extend the fake-Pi session-index coverage). Full `npm run check` still applies per the repo definition of done.

### Assumption

The likely loss is `hubStore.list()` preferring `header.name` from the bounded JSONL scan; a name that exists only in `sessions.json` (for example a rename outside the head/tail window) becomes `undefined` once the session is scanned as stopped. The fix is a list fallback to the index record plus an index write on stop, not a JSONL rewrite.

### Implementation

- `hubStore.list()` now uses `header.name ?? record.name` for scanned JSONL rows, so a name that lives only in `sessions.json` survives the stopped listing without rewriting the JSONL.
- `hubLive.stop()` persists the live session's name to the index before closing the child; this covers explicit stop and idle detach through the same path.
- `hubStore.upsertIndex()` ignores a blank/missing provided name instead of letting it erase an existing record name.
- Tests added in `test/index.test.ts`: index-name fallback for a nameless JSONL and a live-name/stop/restart flow.

Verified with `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` (all suites green, 321 root tests). Parent commit `76330554c6ca6dc1174f1249cbd5ae99b1eaec1c`.

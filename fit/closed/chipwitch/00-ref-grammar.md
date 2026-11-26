---
grilled: true
project: pixip
series: chipwitch
title: "Define the `[pixip-ref=…]` tag grammar as one pure parser/formatter pair shared by the client, the CLI and the docs, so a reference copied in one place is recognized byte-identically everywhere."
---

Define the `[pixip-ref=…]` tag grammar as one pure parser/formatter pair shared by the client, the CLI and the docs, so a reference copied in one place is recognized byte-identically everywhere.

### Format

- `[pixip-ref=history/<logicalSessionId>/<entryId>]` — a painted history block (`data-entry`).
- `[pixip-ref=history/<logicalSessionId>/msg:<role>:<timestamp>]` — a block painted from a live event, which has no Pi entry id yet. The key is the one `coverageKey()` already derives in `src/jsonl.ts`.
- `[pixip-ref=inbox/<inboxMessageId>]` — an inbox message.
- Kind-prefixed and positional. The session component is required: `/fork` and `/clone` copy the JSONL with the same entry ids, so an entry id alone is ambiguous. Logical ids are minted (`SessionIndexRecord.logicalId`), so `history`/`inbox` cannot collide with one.
- Strict charset, documented and tested: session/logical ids and entry ids `[A-Za-z0-9._-]+`, msg role `[a-z][a-z0-9]*`, timestamp digits. Anything else in prose stays literal text and must never be swallowed.
- Brackets only. `parseRefTag`/`scanRefTags` match the full bracketed tag and accept no bare-address alias; ticket 40's CLI may accept a bare address through its own lenient path without changing the shared grammar.

### Modules

- `src/client/reftags.js` — the one canonical implementation: `formatRefTag`, `parseRefTag`, `scanRefTags(text)` returning matches in order with offsets. Plain JS so the browser imports it directly with no build step; cluster-neutral (like `queueView.js`).
- `src/reftags.ts` — a thin typed re-export for the hub, CLI and tests. It must not hold a second regex; the implementation lives only in `src/client/reftags.js`.
- `src/client/reftags.js` also exports the derived `msg:` key helper, so the live and snapshot paths agree.
- `docs/reftags.md` documents the grammar; `AGENTS.md` gains the one-line convention (`refs look like [pixip-ref=…]; resolve with pixip ref or sessions.json + the JSONL`), which is auto-loaded and therefore costs no per-prompt tokens.
- One regex, one place. No copies in the client, the hub or the extension.

### Acceptance

- Round-trip format → parse for all three kinds; unknown kind or malformed input returns `null`/no match, never throws.
- `formatRefTag` is a total function and returns `null` for an invalid or unknown structure; callers render the input as text.
- The `msg:` derivation agrees with `coverageKey()` for the same message (one test importing both).
- `scanRefs` covers multiple refs on a line, adjacent refs, refs across newlines, and trailing punctuation.
- A literal `[pixip-ref=…]` that does not parse is a non-match, so callers render it as text.
- `npm run check` green.

### Boundaries

- Do not touch the parallel hot-reload work: `fit/open/hotreload/`, `fit/closed/hotreload/`, `src/daemon.ts`, `src/hub.ts`, `src/hubControl.ts`, `src/hubLive.ts`, `src/hubStore.ts`, `src/wire.ts`, `src/backend.ts`, the `run`/`daemon` verbs in `bin/pixip.ts`, `tools/reload-bench.mjs`. `pixip/hot-reload` owns those in another worktree; this series is client-side and must merge cleanly beside it.
- Import `coverageKey()` from `src/jsonl.ts`; do not refactor that module or change its key format.
- No hub route, no protocol field, no extension. If a change appears to need one, stop and grill first.
- Board writes stay inside `fit/open/chipwitch/` and `fit/closed/chipwitch/`. `fit/open/20-remind-from-pre-compaction.md` may be read but not moved.
- Expect a later merge conflict with `pixip/hot-reload` in `tools/check-client-imports.mjs` and `tools/browser-check.mjs`; keep both sides' additions.

### Testing

- `npm run check` green before closing (typecheck, lint, format, import guard, node tests, browser-check, workspace checks).
- Unit coverage lives in `test/reftags.test.ts`; run it alone with `node --test test/reftags.test.ts` while iterating.
- This worktree's daemon needs its own isolation: `node bin/pixip.ts --data-dir ./tmp/refs --port 8138`. Never point it at the master checkout's data dir, and never attach two processes to one session file.
- Client assets reload under `--dev`; no daemon restart is needed for client-only changes.

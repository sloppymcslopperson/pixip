---
grilled: true
commit: "705a6e6da1f9d94a59ba55e9019590ab95640385"
---

### Verification

- `npm run check` green: typecheck + 34 tests, including `markdownToHtml` coverage for GFM blocks, table wrapper, link target/rel, unsafe-scheme drop, raw-HTML escaping, verbatim fenced code, empty input, literal user messages and ANSI thinking blocks.
- `tools/shot.mjs` at 390 and 1280 against a fixture session with a table, fenced block, lists, quote, links and literal user markdown: no console errors, `overflowX: false`, log width 390/1040.
- streaming path unchanged: deltas stay in `.live-text` (now explicitly `pre-wrap`); `message_end` swaps in rendered markdown.

### Implementation notes

- `src/client/markdown.js` wraps the vendored `marked` build with three overrides: raw HTML tokens escaped, links limited to `http(s)`/`mailto`/`#` and opened with `rel="noopener noreferrer"`, tables wrapped in `.md-table`.
- `render.js` imports `escapeHtml`/`markdownToHtml` from it and re-exports `escapeHtml`, so existing tests and callers are unchanged.
- Table cells use `overflow-wrap: normal` so inline code keeps its token and the wrapper scrolls instead of breaking mid-word on a phone.
- `ARCHITECTURE.md` untouched: no wire or latency change.

commit: 705a6e6

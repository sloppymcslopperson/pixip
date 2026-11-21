---
grilled: true
commit: "6d565f28d5dfa661ce4c5308396de88804efce10"
---

Surface Pi extension `setStatus` and `setWidget` requests in pixip so addon status entries and input-area widgets are visible. The hub caches the current addon UI per live child and replays it after attach, so reconnecting clients see the same state.

### Scope

- Handle `extension_ui_request` methods `setStatus` and `setWidget`.
- Ignore `setTitle` and `set_editor_text` for this ticket; `notify` keeps its existing toast behavior.
- Keep the existing verbatim event forwarding for extension UI requests.

### Decisions

- All addon UI lives in the footer area, ordered: `aboveEditor` widgets, then status entries, then `belowEditor` widgets, then the built-in footer.
- Status entries are keyed by `statusKey`, ordered by first appearance, updated in place, and cleared when `statusText` is undefined/omitted (or empty).
- Widgets are keyed by `widgetKey`, ordered by first appearance within their placement, updated in place, and cleared when `widgetLines` is undefined/omitted (or empty).
- Missing/unknown `widgetPlacement` defaults to `aboveEditor`.
- Widget rows have a capped height (about 6 lines) with internal scrolling so a verbose addon cannot push the composer off-screen.
- The hub keeps the latest status/widget state per live session and replays it after attach; state is dropped when the child detaches or exits.
- Replayed frames use the existing `extension_ui_request` shape so the client has one rendering path.

### Acceptance

- A `setStatus` request shows text in the footer, an update replaces it, and a clear removes it.
- A `setWidget` request shows its lines above or below the composer per placement, and a clear removes it.
- Multiple keys appear in insertion order and never duplicate.
- Reconnecting or opening a second tab for a live session shows the currently cached addon UI without waiting for the extension to re-emit.
- Detaching the child clears its cached addon UI.
- Long widgets scroll inside their capped row instead of expanding the footer indefinitely.

### Files

- `src/hub.ts` (per-live-session addon UI cache, attach replay, detach cleanup)
- `src/client/app.js` (`handleUiRequest`, footer render path)
- `src/client/style.css` (footer status rows and capped widget rows)
- `test/` for hub cache and client rendering helpers

### Tests

- Hub test: set/update/clear status and widgets are forwarded and replayed on a second attach; detach clears them.
- Client/pure render test: footer row order, insertion ordering, and clear semantics.
- `npm run check` green, plus `tools/shot.mjs` at 390 and 1280 with statuses and both widget placements visible.

### Constraints

- No Pi extension or plugin changes; consume only the documented RPC extension UI methods.
- Do not re-encode normal Pi events on the hot path; caching is limited to the small current-status map.
- Cache only current keys, not a history.

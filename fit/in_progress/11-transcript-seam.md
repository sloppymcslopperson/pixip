---
project: pixip
grilled: true
---

Extract the transcript's scroll and windowing seams while keeping the append-only HTML painter and rAF delta path deliberately isolated. The goal is testable scroll/merge/chunk logic without changing transcript performance or behaviour.

### Work

- Extract reading-position helpers: pinned distance, stick detection, jump visibility, and restore-after-prepend.
- Extract window planning: entry weighting, tail merge/dedupe, first-paint slice and chunk sizing.
- Keep `renderTranscript`/`htmlOf` and the direct `textContent +=` delta flush as the deliberate imperative painter; do not turn it into per-entry components.
- Keep the inline surface outside `#log` so transcript repaints cannot wipe it.
- Add Node tests for the extracted scroll/window helpers and keep the existing render tests intact.

### Acceptance

- Window/scroll math is testable without DOM.
- First paint remains 24 KB and fill chunks 32 KB; live deltas still flush in one rAF.
- Loading earlier history preserves the reading position; jump-to-newest still works.
- `npm run check` green; 390/1280 transcript screenshots unchanged.

### Out of scope

- A framework migration, virtual DOM, or changing the append-only transcript strategy.

### Grilling

- **Two new pure modules.** `transcriptScroll.js` owns pinned distance, stick detection, jump visibility and restore-after-prepend distance math. `transcriptWindow.js` owns entry weighting, tail merge/dedupe, first-paint slice and chunk planning. `transcript.js` keeps `renderTranscript`/`htmlOf` and the direct `textContent +=` rAF delta flush as the deliberate imperative painter; the inline surface stays outside `#log`.
- **Fully pure API.** Pass entries/state in and return values, for example `mergeTail(previous, incoming, more) -> {entries, more}`, `planTail(entries, budget)`, `scrollDistance(...)`. `transcript.js` keeps only thin stateful wrappers that assign results back to `state` and call the painter. No DOM inside the extracted helpers.
- **Tests** cover the pure scroll/window helpers without DOM; existing render and windowing tests stay intact.
- **Budgets unchanged:** first paint 24 KB, fill chunks 32 KB, live deltas in one rAF. Loading earlier history preserves reading position; jump-to-newest keeps working. Verify with 390/1280 screenshots via the local headless Chrome path recorded in ticket 09.

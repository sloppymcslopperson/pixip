---
project: pixip
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

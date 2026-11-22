---
project: pixip
---

Make the inline panel grow into the available vertical space when its content overflows, instead of sizing to content and leaving usable space above it unused. Keep the collapsed state header-only and keep `#log` the only page-level scroll container.

### Current behaviour

`#surface` is `flex: none` with `max-height: 70%`; a long A2UI questionnaire body scrolls inside a panel that is shorter than the space above the composer. With a tall viewport and a short transcript the owner saw a cramped panel and unused space above it.

### Work

- Let the panel take the available space up to a safe cap: grow with content, then scroll the `.surface-body` internally once the cap is reached. Do not stretch a short panel just to fill space.
- Account for the header, the Replace banner, the composer and the safe-area padding (`--surface-height` / jump-pill offset must stay correct).
- Keep collapsed mode at the header height and keep the transcript scroll position when the panel grows.

### Acceptance

- A long questionnaire panel at 390 and 1280 uses the space above the composer, scrolls internally, and does not scroll the page or the transcript unexpectedly.
- A one-question panel still sizes to its content rather than stretching.
- Collapse/expand, the jump pill and the Replace banner still work; `tools/shot.mjs` shows both widths.

### Files

- `src/client/surface.css` (and `surface.js` only if the height calculation needs a JS hook).
- `tools/shot.mjs` / a long A2UI fixture for the before-and-after shots.

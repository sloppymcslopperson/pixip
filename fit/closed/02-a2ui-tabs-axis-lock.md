---
grilled: true
project: pixip
commit: "0ed8c82e96e45a6b69c2f84b9a095b464940e9e7"
---

The A2UI tab bar scrolls horizontally, but its vertical axis is still draggable/playable, so a horizontal swipe starts with vertical movement before settling. Lock the tab bar to horizontal panning while keeping the sticky header and panel layout from `02-a2ui-tabs-scroll`.

### Report

On a many-tabs panel, dragging the tab line horizontally produces vertical play before the horizontal scroll settles. The tab bar is an overflow container, so its computed vertical overflow/touch action still lets the gesture pan the ancestor vertically.

### Fix

- Add `overflow-y: hidden` and `touch-action: pan-x` to `.a2ui-tab-bar` in `tools/a2ui-entry.js`.
- Keep `overscroll-behavior` containment on both axes so the gesture cannot chain into `.surface-body`.
- Rebuild `src/client/vendor/a2ui.esm.js` and update the local-patch note in `src/client/vendor/a2ui.README.md`.

### Acceptance

- A horizontal swipe on the tab line does not move the panel/body vertically before the tab bar scrolls.
- Vertical swipes starting outside the tab bar still scroll `.surface-body`.
- Sticky tab bar, horizontal overflow, 390px panel containment and 1280px short-tab behavior from `02` still hold.
- `npm run check` green.

### Files

- `tools/a2ui-entry.js`, `src/client/vendor/a2ui.esm.js`, `src/client/vendor/a2ui.README.md`.
- `tools/shot.mjs` if an axis metric is useful for verification.

### Decisions

- Keep the fix in the vendored renderer's shadow/light-DOM styles; no client CSS override can cross the component boundary.
- Rebuild and commit the vendored asset; CI still never runs the bundler.

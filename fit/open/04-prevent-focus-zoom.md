---
grilled: false
---

On iOS Safari, tapping into a text entry field zooms the page instead of just focusing the field, which is disorienting in the composer, surface fields and sheet/A2UI inputs.

### Work

- Audit every text entry control (composer `#input`, `.surface-field`, sheet inputs, A2UI shadow-root fields, rename prompts) for computed `font-size` below 16px, which is what triggers iOS auto-zoom.
- Raise offending controls to at least 16px, or otherwise prevent the focus zoom without disabling pinch-zoom / user scaling (do not use `maximum-scale=1` or `user-scalable=no`).
- Cover the A2UI shadow roots: the vendored renderer's inputs need a theme/style hook so they also stay at 16px.

### Acceptance

- Focusing any text field on a 390px-wide viewport does not change page scale; pinch-zoom still works.
- `npm run check` green; `tools/shot.mjs` at 390 and 1280 still clean.

---
grilled: true
project: pixip
commit: f9e9007f38e03bf07472d450e948aae07b11c64b
---

On iOS Safari, tapping into a text entry field zooms the page instead of just focusing the field, which is disorienting in the composer, surface fields and sheet/A2UI inputs.

### Work

- Audit every text entry control (composer `#input`, `.surface-field`, sheet inputs, A2UI shadow-root fields, rename prompts) for computed `font-size` below 16px, which is what triggers iOS auto-zoom.
- Raise offending controls to at least 16px, or otherwise prevent the focus zoom without disabling pinch-zoom / user scaling (do not use `maximum-scale=1` or `user-scalable=no`).
- Cover the A2UI shadow roots: the vendored renderer's inputs need a theme/style hook so they also stay at 16px.

### Acceptance

- Focusing any text field on a 390px-wide viewport does not change page scale; pinch-zoom still works.
- `npm run check` green; `tools/shot.mjs` at 390 and 1280 still clean.

### Grilled decisions

- Owner ask: "make the page not zoom in when I tap into a text entry field." Clear enough to implement without another round.
- Fix by keeping text-entry controls at least 16px, never by disabling pinch-zoom or user scaling. `#input`, `.surface-field` and `#sheet input` already meet this; `#new-row input` (dashboard path) and the A2UI shadow-root fields inherit 15px/14px and need the fix.
- A2UI inputs inherit the font size of `a2ui-surface` inside the shadow roots, so raise that surface to 16px in `surface.css` rather than editing the vendored bundle.
- Baseline meta viewport stays unchanged (`width=device-width, initial-scale=1, viewport-fit=cover`).
- No new layout: verify with the existing 390/1280 shots and `npm run check`.

### Verification

- `#new-row input` is now 16px, so focusing the dashboard path field no longer triggers iOS auto-zoom.
- `.a2ui-root a2ui-surface` is 16px; A2UI inputs inside the shadow roots inherit it. Measured in a 390px emulated viewport: dashboard path field 16px, composer 16px, A2UI text field 16px, long-text textarea 16px; radio/file controls stay small and are not text entry.
- No viewport-scale change: `initial-scale=1` is untouched and pinch-zoom remains enabled.
- `tools/shot.mjs` at 390 and 1280 reports no page scroll, no horizontal overflow and no console errors.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and root tests (259 pass) are green.

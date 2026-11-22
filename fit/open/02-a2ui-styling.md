---
project: pixip
---

Polish the A2UI panel styling so it matches the rest of pixip instead of looking odd next to the transcript, composer and sheets. The vendor renderer stays untouched: target the `.a2ui-root` wrapper and the documented `--a2ui-*` theme variables only.

### Observed

The owner tested the questionnaire panel and called the styling "a bit odd". Known candidates from that run; confirm the actual list during grilling:

- the panel title appears twice (surface title text plus the surface header);
- tab bar underline and inactive-tab contrast;
- choice-picker radio circles and label spacing;
- text-field label, placeholder and vertical alignment;
- Cancel/Submit sizing and spacing compared with `.surface-actions`;
- overall spacing density on phone versus desktop.

### Scope

- CSS and theme-variable mapping in `src/client/surface.css` (and a title change in the extension's `buildSurface` if the duplicate title is the chosen fix).
- No vendor bundle rebuild unless a needed variable is missing from the 0.15.0 catalog.
- No layout/markup duplication per breakpoint.

### Acceptance

- 390 and 1280 shots of the questionnaire panel expanded and collapsed look intentional: readable contrast, consistent spacing, no duplicated title.
- `npm run check` green; no functional change to submit/cancel/custom text.

### Files

- `src/client/surface.css`, possibly `extensions/pixip-questionnaire/src/surface.ts` for the title.

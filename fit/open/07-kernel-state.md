---
project: pixip
---

Extract the shared mutable state and DOM element map out of `app.js` into kernel modules with state slices and selectors, preserving behaviour and layout. This is the first step of the post-A2UI client normalization.

### Work

- Add `src/client/state.js` and `src/client/ui.js` (or a small `kernel/` folder) and move the ~40-field state object and the `$`/element map out of `app.js`.
- Split state into logical slices: connection, dashboard, session, transcript, composer, addon/panel. Keep one state container; no reactive framework and no per-feature stores yet.
- Move state initialization, reset helpers and common derived selectors into the kernel. Keep DOM out of `state.js` and state out of `ui.js`.
- Update imports so modules depend on the kernel rather than reaching into `app.js`. Preserve all existing behaviour, protocol handling and layout.
- Document the slices in `ARCHITECTURE.md` and keep the module map accurate.

### Acceptance

- `app.js` no longer defines the shared state object or the element map.
- No duplicate `document.querySelector` bootstrapping; every module imports the owning kernel module.
- `npm run check` green; `tools/shot.mjs` at 390 and 1280 shows dashboard, session, surface and sheet unchanged.
- No wire-protocol, latency or visual change.

### Out of scope

- Removing the `app.js` barrel/cycles (`08-composition-root`), feature splits (`09`/`10`), and new UI behaviour.

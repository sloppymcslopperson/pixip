---
project: pixip
---

Turn `app.js` into a composition root and remove the 207-name barrel and the feature-to-`app` import cycles. Feature modules should import the kernel or pure helpers directly; `main` wires routing, frames and cross-feature interactions.

### Work

- Make `app.js` (or a renamed `main.js`) the only module that imports all features and wires them together.
- Remove the giant export block. Consumers import from the module that owns each symbol.
- Move frame dispatch into a small protocol adapter (or keep one switch in `main`/`frames.js`) and route frame effects to feature handlers instead of letting `session.js` reach into every feature.
- Define explicit navigation/intent calls for dashboard ↔ session instead of direct feature imports. No new event bus.
- Preserve boot order, hash routing, socket lifecycle, addon replay and all existing behaviour.

### Acceptance

- No import cycles and no feature imports `app.js`.
- `app.js`/`main.js` is a composition root, not a feature dump; the export barrel is gone.
- `npm run check` green; 390/1280 screenshots unchanged; no latency or protocol change.
- `ARCHITECTURE.md` dependency direction matches the code.

### Out of scope

- Splitting dashboard/composer/transcript internals (`09`/`10`/`11`), the import-graph guard (`12`), and new features.

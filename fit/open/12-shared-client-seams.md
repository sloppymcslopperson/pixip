---
project: pixip
---

Extract the generic client seams that currently live inside feature controllers so later boundary work has clean shared modules. This is a mechanical move with no intended behaviour, layout or protocol change.

### Work

- Add `src/client/scroll.js` with `scheduleScroll`, `scrollToEnd`, `updateJump` and `restoreDistance`; move them out of `controls.js` and repoint callers.
- Add `src/client/menuView.js` with `closeMenu`; move it out of `controls.js`.
- Add `src/client/composerInput.js` with `clearInput` and `resize`; move `clearInput` out of `composer.js` and `resize` out of `controls.js`.
- Add `src/client/queueView.js` with `renderQueue`; move it out of `controls.js`.
- Add `src/client/transcriptView.js` with `appendBlock`, `showThinkingIndicator` and `hideThinkingIndicator`; move them out of `controls.js`.
- Add `src/client/sessionView.js` with `renderAddonWidgets`, `renderFooter`, `applyInfo` and `setBusy`; move them out of `controls.js`.
- Keep `controls.js` as the scale/refresh/bar-menu controller and update every import in `app.js`, `composer`, `composerBash`, `dashboard`, `frames`, `menu`, `session`, `sessionEffects`, `sheets` and `transcript`.
- Keep shared modules below features: they may import kernel, pure helpers and other shared modules, never a feature controller.

### Acceptance

- The moved functions exist in exactly one module; no compatibility wrappers or duplicate copies.
- `npm run check` green and `tools/shot.mjs` at 390 and 1280 shows no page errors, layout change or horizontal overflow.
- No cross-feature configure callbacks are added in this ticket; the remaining feature-to-feature imports are deliberately left for ticket 13.

### Decisions from grilling

- Shared resources move down into modules both sides import; callbacks in ticket 13 are for orchestration, not for generic helpers.
- No event bus, no global service locator and no bundler.
- Commit as one logical ticket commit after the checks are green.

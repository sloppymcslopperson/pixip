---
grilled: true
project: pixip
commit: aa6ae8bab3cf53f02a0a25b63624483e54791039
---

Fix the A2UI Tabs renderer so the tab line scrolls horizontally while the content stays inside the panel, instead of the whole surface expanding to the tab bar's max-content width.

### Root cause

Reproduced at 390px with a seven-tab surface: `#surface .surface-body` has `clientWidth 390` but `scrollWidth 589`, so the entire panel scrolls sideways and the first tab can be pushed off-screen left. The vendored `a2ui-tabs` host shrink-to-fits, `.a2ui-tab-bar` has no wrap or horizontal overflow, and `.a2ui-tab-content { width:100% }` inherits the expanded tab-bar width.

### Work

- Patch the vendored renderer at its source entry (`tools/a2ui-entry.js`), not the built `a2ui.esm.js`: override the Tabs element's static styles before `registerUniversalElement`.
- Tabs shadow styles to add:
  - `:host { display:block; width:100%; min-width:0; }`
  - `.a2ui-tabs { min-width:0; }`
  - `.a2ui-tab-bar { overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:thin; }`
  - `.a2ui-tab-button { flex:0 0 auto; white-space:nowrap; }`
  - `.a2ui-tab-content { min-width:0; overflow-x:hidden; }`
  - sticky tab bar (`position:sticky; top:0` with a background) so the tab line stays visible while the body scrolls vertically.
- Rebuild `src/client/vendor/a2ui.esm.js` with `node tools/build-a2ui.mjs` and note the local patch in `src/client/vendor/a2ui.README.md`.

### Acceptance

- With a many-tabs A2UI panel at 390px, the tab bar scrolls horizontally, the content and footer stay within the panel width, and `surface-body` has no horizontal overflow (`scrollWidth === clientWidth`).
- The tab line stays visible while long content scrolls vertically.
- At 1280px a short tab set still fits normally.
- Add a many-tabs dev fixture (6-8 tabs) and extend `tools/shot.mjs` metrics with `clientWidth`/`scrollWidth`; include 390 and 1280 shots.
- `npm run check` green.

### Files

- `tools/a2ui-entry.js`, `tools/build-a2ui.mjs` invocation, `src/client/vendor/a2ui.esm.js`, `src/client/vendor/a2ui.README.md`.
- `test/fixtures/` many-tabs fixture and the dev fixture route if a new filename is needed.
- `tools/shot.mjs` layout metrics.

### Grilled decisions

- Keep the fix in the renderer's shadow styles; do not add a client-side CSS override that cannot cross the shadow boundary.
- Sticky tab line is part of this ticket; content vertical scrolling remains owned by `.surface-body`.
- No questionnaire model changes and no TUI changes; this is the client Tabs renderer only.
- Rebuild and commit the vendored asset; CI still never runs the bundler.

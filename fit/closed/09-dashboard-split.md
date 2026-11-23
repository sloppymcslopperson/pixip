---
project: pixip
grilled: true
commit: d4b006bd0642c5cae1acc2c7e50fd0d3963b018a
---

Split `dashboard.js` into a session-list API, list/group rendering, directory picker, and settings/archive surfaces, with pure helpers covered by Node tests. Preserve the current dashboard behaviour and responsive layout.

### Work

- Extract HTTP/session-list data access (`listSessions`, `refreshDashboard`, archive/delete calls) from rendering.
- Separate session list and cwd grouping from the directory picker and settings/archive sheets.
- Move pure grouping, formatting and filtering helpers into testable modules; keep controllers thin and event-driven.
- Keep `sessionGroups.js`, `sessionInfo.js` and `directoryPicker.js` as the pure engines and extend their tests rather than duplicating logic.
- Wire feature-to-feature navigation through the composition root/router established by `08-composition-root`.

### Acceptance

- No dashboard module mixes HTTP, persistence and unrelated sheet rendering in one file.
- Existing dashboard interactions still work: new session, groups, branch chips, collapse/pin, picker, archive/restore/delete, settings.
- New pure helpers have Node tests; `npm run check` green.
- `tools/shot.mjs` at 390 and 1280 shows the dashboard, a group and the directory picker unchanged.

### Out of scope

- Desktop session-card surface, new dashboard features, and framework changes.

### Grilling

- **Module layout (four modules).** `dashboard.js` stays the dashboard feature entry point and keeps `showList`, route reset and orchestration. New `dashboardApi.js` owns all fetch/HTTP (`listSessions`, `apiJson`, `refreshDashboard`). New `dashboardList.js` owns the new-session row, group sections and session rows. New `dashboardPicker.js` owns the directory-picker state and DOM. New `dashboardSettings.js` owns settings, archive/trash lists, confirm sheets, archive/delete/archive-inactive and restore/purge.
- **Pure helpers.** Extract more than the existing engines: at minimum the draft-preserving new-row value, inactive-session count, group-toggle visibility decision, picker transition/notice state and stored-row labels become pure functions. Test them in Node; also extend `sessionGroups`/`sessionInfo`/`directoryPicker` tests where the split exposes gaps.
- **showList stays in `dashboard.js`**, not `app.js`. `app.js` remains the composition root; dashboard navigation continues through `navigation.js` (no feature-to-feature imports added).
- **Settings surfaces** move to `dashboardSettings.js`; `sheets.js`/`sheetShell.js` stay generic and untouched except for imports.
- **Verification.** `tools/shot.mjs` will use the local headless Chrome at `/tmp/pixip-chrome/chrome-headless-shell/linux-158.0.8127.36/chrome-headless-shell-linux64/chrome-headless-shell` at 390 and 1280. Dashboard, group and picker screenshots must look unchanged.

### Implementation note

`refreshDashboard` landed in `dashboardList.js`, not `dashboardApi.js`: it is the two-line "fetch then paint" orchestration and calling `renderList` from the HTTP module would mix the layers. The archive/delete/archive-inactive calls stay in `dashboardSettings.js` and use `dashboardApi.apiJson`. Pure display logic lives in `dashboardModel.js` so Node tests do not load the DOM kernel.

Verified with `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` (all suites green) and `tools/shot.mjs`/a picker+group probe at 390 and 1280 (no overflow, no console errors). Parent commit `d4b006bd0642c5cae1acc2c7e50fd0d3963b018a`.

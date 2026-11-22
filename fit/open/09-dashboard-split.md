---
project: pixip
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

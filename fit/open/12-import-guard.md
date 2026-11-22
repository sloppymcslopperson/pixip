---
project: pixip
---

Add an import-graph guard and scripted browser checks that enforce the normalized client boundaries and catch regressions in the dashboard, session, composer and surface flows. Update the module map at the same time.

### Work

- Add a small `tools/` check (or Node test) that fails on import cycles, feature modules importing the composition root, and direct feature-to-feature imports outside the agreed routing/callback boundary.
- Wire the check into `npm run check` without adding a bundler or a new runtime dependency.
- Add scripted browser coverage for the main flows: dashboard → session, composer submit, inline surface answer/cancel/collapse, history scrolling.
- Update `ARCHITECTURE.md` with the dependency rule and the scripted-check path.

### Acceptance

- The import check fails on a deliberately introduced cycle/forbidden import and passes on the real client.
- Scripted checks run at 390 and 1280 with no page errors or horizontal overflow.
- `npm run check` includes both guards and stays green.
- The module map matches the final normalized layout.

### Out of scope

- New product features, framework migration, and performance work beyond the existing budgets.

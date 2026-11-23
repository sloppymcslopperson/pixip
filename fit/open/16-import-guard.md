---
project: pixip
grilled: true
---

Add a small import-graph guard that enforces the normalized client boundaries and update `ARCHITECTURE.md` so the module map matches the final layout. The guard must catch regressions rather than permit the current graph.

### Work

- Add `tools/check-client-imports.mjs` using the existing TypeScript compiler API (no new dependency) to parse static and dynamic imports in `src/client`, ignoring `vendor/`.
- Fail on: import cycles; any module importing `app.js`; feature modules importing a different feature cluster; modules outside `frames.js`/`app.js` importing feature handlers. Keep the cluster map in one place in the tool and document it.
- Add a Node test that proves the guard rejects a synthetic cycle and a synthetic forbidden cross-cluster import, and passes the real client.
- Wire `check:imports` into `npm run check` before the test step.
- Update `ARCHITECTURE.md` with the dependency rule, the `app.js`/`frames.js` exceptions, the configure-callback boundary, the guard path and the scripted browser-check path. Update the module map for `scroll`, `menuView`, `composerInput`, `queueView`, `transcriptView`, `sessionView`, the configure functions and `tools/*`.
- Update `README.md` only where the test/check command list or module map is now stale.

### Acceptance

- Deliberately introducing a cycle or a forbidden feature import makes `check:imports` fail; the real client passes.
- `npm run check` includes the import guard and stays green.
- The module map and dependency rule in `ARCHITECTURE.md` match the final code, with no modules missing.

### Depends on

- Tickets 12 and 13. Ticket 14 is independent but its docs path should be linked from the same architecture update.

### Decisions from grilling

- Import policy: full layered refactor, not an allowlist. `app.js` is the composition root; `frames.js` is the only protocol adapter that may import feature handlers. Features may import kernel, pure/domain helpers, shared primitives, and same-cluster siblings. They must not import another feature cluster directly.
- Cross-feature calls use option B: explicit per-module `configureX({ ...callbacks })` functions, installed once by `app.js`. No global ports/service locator and no event bus.
- Shared resources move down into a module both sides import when possible; callbacks are for orchestration, not for sharing generic helpers.
- Feature clusters: dashboard (`dashboard`, `dashboardApi`, `dashboardList`, `dashboardPicker`, `dashboardSettings`, `dashboardModel`), session (`session`, `sessionEffects`, `sessionPlan`), composer (`composer`, `composerAttachments`, `composerBash`). Intra-cluster imports stay direct but cycles are forbidden.
- Commit as one logical ticket commit after the checks are green.

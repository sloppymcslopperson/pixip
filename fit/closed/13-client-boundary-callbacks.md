---
project: pixip
grilled: true
---

Introduce explicit per-module `configureX({ ...callbacks })` boundaries, remove the remaining cross-cluster feature imports and break both existing import cycles without behaviour changes. This is the prerequisite for the import guard in ticket 16.

### Work

- Add `configureComposer({ surfaceOpen })`, `configureDashboard({ clearPendingAttachment, resetSurface })`, `configureDashboardList({ archiveInactive, openSessionActions })`, `configureDashboardSettings({ sheet })`, `configureMenu({ submit })`, `configureSession({ clearPendingAttachment, resetSurface, renderTranscript })`, `configureSessionEffects({ clearPendingAttachment, failPendingSession, openSession, appendRestartNotice, lastEntryId, renderResume, renderSnapshot, renderTranscript })`, `configureSheets({ openSurfaceRequest })` and `configureTranscript({ handleUiRequest })`.
- Install every configure function once from `app.js`; no global ports object and no subscriptions/events.
- Break `composer.js <-> composerBash.js`: `composerBash` must not import `composer`; both use `composerInput.js` for `clearInput`.
- Break `dashboardList.js <-> dashboardSettings.js`: `dashboardList` uses the configured session-action and archive-inactive callbacks; `dashboardSettings` may keep its direct dashboard-cluster imports.
- Remove the remaining cross-cluster imports: composer→surface; dashboard→composerAttachments/surface; dashboardSettings→sheets; menu→composer; session→composerAttachments/surface/transcript; sessionEffects→composerAttachments/session/transcript; sheets→surface; transcript→sheets.
- Keep intra-cluster imports direct: dashboard cluster (`dashboard`, `dashboardApi`, `dashboardList`, `dashboardPicker`, `dashboardSettings`, `dashboardModel`), session cluster (`session`, `sessionEffects`, `sessionPlan`), composer cluster (`composer`, `composerAttachments`, `composerBash`).
- `app.js` remains the only composition root; `frames.js` remains the only protocol adapter allowed to import feature handlers.

### Acceptance

- No feature module imports another feature cluster directly and the client dependency graph has no cycles.
- `npm run check` green; `tools/shot.mjs` at 390 and 1280 shows the dashboard, session, composer, surface and sheets unchanged.
- No wire, latency or visual change.

### Depends on

- Ticket 12 (shared client seams), because it creates the lower modules that remove most of the current edges.

### Decisions from grilling

- Option B: explicit per-module configure functions installed by `app.js`.
- Prefer extracting a genuinely shared resource downward over adding a callback.
- No allowlist and no global ports/service locator.
- Commit as one logical ticket commit after the checks are green.

### Grilling answers

- Missing callbacks fail fast: `installDeps` validates every required function when `configureX` is called, so a wiring mistake throws with the module and callback name.
- No new tests; `npm run check` plus the 390/1280 shots are the acceptance evidence.
- One commit with subject `Add client configure boundaries`.
- `composer → composerBash` was already one-way after ticket 12; the only remaining cycle was `dashboardList ↔ dashboardSettings`.

### Outcome

- Added `src/client/configure.js` with `installDeps` and `configureX` in composer, dashboard, dashboardList, dashboardSettings, menu, session, sessionEffects, sheets and transcript. `app.js` installs all nine once before `configureTransport`, `configureNavigation` and `route`.
- Removed the cross-cluster edges composer→surface, dashboard→composerAttachments/surface, dashboardList→dashboardSettings, dashboardSettings→sheets, menu→composer, session→composerAttachments/surface/transcript, sessionEffects→composerAttachments/session/transcript, sheets→surface and transcript→sheets.
- `dashboardSettings` keeps its direct dashboard-cluster imports; `composerBash` never imported `composer` after ticket 12. A full import scan over all 50 client modules reports no cycles.
- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` green (334 root tests, both workspaces). The unrelated untracked `UI_WIDGET_BREAKDOWN.html` was moved aside only for the prettier pass, then restored.
- `tools/shot.mjs` at 390 and 1280: dashboard and session clean (`overflowX: false`, `problems: []`). A temporary deterministic check also opened the settings sheet, session actions, session footer sheet and the A2UI fixture panel at both widths: all visible, `overflowX: false`, no page or console errors, panel collapses.

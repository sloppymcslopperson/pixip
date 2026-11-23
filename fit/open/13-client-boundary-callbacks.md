---
project: pixip
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

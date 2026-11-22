---
project: pixip
---

Add a read-only plugin inventory to the settings surface and a per-pixip disable list, so the hub can show which Pi packages and extensions a session would load and exclude one without editing the user's global Pi settings. This is the first slice of `90-pi-plugin-isolation` and removes the remaining operational dependency on `pi_questionare`.

### Scope

- Hub `GET /plugins`: read the same sources Pi reads (user agent-dir settings `packages`/`extensions`, project `.pi/settings.json`, pixip overrides), resolve paths, and report `{source, kind, exists, providesQuestionnaire}`. Detection is a manifest/`registerTool` scan, never execution.
- Client settings sheet: list sources with name, path, existence, a legacy questionnaire badge, and the active questionnaire path (A2UI panel → TUI custom → dialogs). Read-only first.
- Per-pixip disable list stored in the pixip data dir. `pi-host` applies it when it builds the `SettingsManager`/resource loader (exclusion entries or omitted package sources), so only pixip sessions change.
- Startup warning when both a legacy questionnaire package and `pixip-questionnaire` are present.

### Constraints

- Never write `~/.pi/agent/settings.json` or a project `.pi/settings.json`; global enable/disable stays with `pi config`/`pi remove`.
- Toggling affects new sessions only; running sessions keep the extensions they loaded.
- No auth or settings-sharing redesign; that remains `90-pi-plugin-isolation`.

### Acceptance

- With both questionnaire packages installed, the sheet shows both, marks the legacy one, and the startup warning appears.
- Disabling the legacy package excludes it from a new pixip session while the TUI still loads it.
- Settings files on disk are unchanged by toggling; tests cover inventory parsing and loader filtering.

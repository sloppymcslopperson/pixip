---
grilled: true
leg: owner-request
project: pixip
---

Automatic session labels should summarize the first prompt with a separate one-shot call on the session's current model, unless `--title-model` / `PIXIP_TITLE_MODEL` explicitly overrides it. Manual renames must continue to win.

### Scope

- Change the default title-model resolution from the cheap `deepseek-v4.1-flash` preference to the live session model.
- Keep the configured override as the first choice.
- Keep the existing one-shot `pi --print --no-session` path and local fallback for now; hanging/timeout hardening is split into a backlog ticket.
- No questionnaire/plugin changes.

### Acceptance

- A new session with no override asks the session model to name it.
- `--title-model` / `PIXIP_TITLE_MODEL` still wins when set.
- `/name <name>` still renames manually and the auto label never overwrites it.
- `npm run check` is green.

### Resolution

- `resolveTitleModel` now picks the live session model by default; `--title-model` / `PIXIP_TITLE_MODEL` remains the first choice, and an override that no longer resolves falls back to the session model.
- When the first title call loses the race with the first turn, the prompt is held and retried once on `agent_settled` with the session model before the local first-words fallback.
- Title-call failures now log the one-shot child's stderr (truncated).
- Manual renaming through `/name <name>` still works and always wins; the existing tests cover renaming before and after the auto label.
- Follow-up hardening is boarded as `backlog/05-harden-title-call.md`.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` → 221/221 pass, typecheck clean.
- New regression test covers the session-model default and the settle retry; existing manual-rename and configured-override tests still pass.
- Daemon restart needed to load the hub change; no client assets or layout changed.

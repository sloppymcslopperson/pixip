---
project: pi-harness
---

Remove the deprecated un-widgeted `questions[]` input shape from `pixip-questionnaire` once widget-shaped calls are the norm, so validation can stop guessing defaults. Ticket `05-pixip-questionnaire` accepts `{prompt, options, multiple}` without `widget` only as a migration bridge.

### Work

- After a deprecation window (at least one release plus a check of real transcripts), require `widget` on every question.
- Replace the defaulting tests with rejection tests that name the valid widgets.
- Update the package README, the tool description, and any in-repo prompts that still emit un-widgeted entries.
- Keep the tool name and the widget union unchanged.

### Acceptance

- An un-widgeted entry fails validation with an error listing valid widgets.
- `npm run check` green and the docs no longer mark the legacy form as accepted.
- No change for widget-shaped calls or for TUI/panel behaviour.

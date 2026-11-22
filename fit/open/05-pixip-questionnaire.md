---
project: pi-harness
---

Create a new Pi extension package that registers the same `questionnaire` tool but builds an A2UI v1.0 surface for the inline pixip panel, while keeping the existing TUI custom UI and dialog fallbacks. It supersedes `pi_questionare` only after the A2UI path is verified; do not modify existing extensions in place.

### Surface design

- One `createSurface` with the Basic catalog ID, `sendDataModel:false`, and a data model of `{answers:{<question-id>:{selected:[], custom:""}}}`.
- Root `Column`: title, `Tabs` (one per question, labelled from `label` or `Q1…`), and a footer `Row` with Cancel and Submit.
- Per question: prompt `Text`, `ChoicePicker` bound to `/answers/<id>/selected` (`multipleSelection` when `multiple`), and a `TextField` bound to `/answers/<id>/custom` with the always-available “Type your own answer” row.
- Submit action context: `{answers:{@path:"/answers"}}`; cancel action name `cancel`. Single-question questionnaires still submit via the button; no hidden auto-submit.
- Normalize answers exactly as the current plugin does (option values only, custom text, `wasCustom`, unanswered) so the model-facing result text stays compatible.

### Transport and fallbacks

- pixip: send the A2UI messages through `ctx.ui.panel()` supplied by `pixip-pi-host` (`00-pi-host-package`, `01-pi-host-integration`, `02-inline-surface`, `03-panel-host`, `04-a2ui-panel-renderer`). The panel appears inline at the bottom of the transcript, expanded by default and collapsible; the user can scroll history while it waits.
- The tool remains blocking: the agent waits for the action or cancel. Do not defer the tool result or add a second response channel.
- TUI: keep the current `ctx.ui.custom` implementation and key handling.
- Other RPC/ACP hosts: keep the sequential dialog fallback, including the typed-text detection and chat hand-off behavior.
- If the panel is missing or closes without a message, report an error asking the model to use plain text; only an explicit cancel is a dismissal.
- Do not persist A2UI surfaces into session history in this ticket. The inline surface is live; a compact answered card can be considered later.

### Acceptance

- A single-select, multiple-select, multi-question, custom-text-only and partial-submit case each produce the expected result text and `details`.
- Explicit cancel is a dismissal; missing/failed panel is an error; no tool call can hang when no client answers.
- TUI behavior is unchanged and covered by the existing tests.
- The package has `npm run check` green and a README describing the transport and host detection.
- Verify side by side against `pi_questionaire` on a real pixip session before recommending removal of the old plugin.
- `tools/shot.mjs` at 390 and 1280 shows a questionnaire-like panel inline, collapsible, and fully expandable.

### Notes

- Prefer a new package name such as `pixip-questionnaire`; keep the tool name `questionnaire` for model compatibility.
- Do not put A2UI construction in pixip itself; the extension owns the surface and the answers.

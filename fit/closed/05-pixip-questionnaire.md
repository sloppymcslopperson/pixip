---
project: pi-harness
grilled: true
commit: "56029b2e309d36e02e36f084376dc7120c7d08ff"
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

### Grilled decisions

- Home and build: new package at `extensions/pixip-questionnaire`, added to the root `workspaces` so `npm run check` runs its check/test/typecheck. Written from scratch for pixip; `pi_questionare` is reference reading only, with no copied TUI code and no runtime dependency.
- Tool: still named `questionnaire`. Input is a widget union: `questions[]` entries of `{id, label?, prompt, widget?, options?, multiple?}`. Defaults: `options` present → `choice`, otherwise `text`. An unknown widget or an option-less choice is a validation error; genuinely ambiguous input errors instead of guessing.
- Legacy entries: an entry without `widget` is accepted as deprecated and defaulted as above. Backlog ticket `questionnaire-legacy-schema` removes that shape later.
- Fallback tiers: A2UI panel when `ctx.ui.panel` exists → reimplemented TUI custom UI → sequential dialogs with the full ACP typed-text detection and "Answer this in chat"/"Add an item in chat" hand-off.
- Surface construction: plain A2UI v1.0 JSON messages by hand; `@a2ui/web_core` is a devDependency used with `import type` only, so the shipped extension has no A2UI runtime dependency.
- Results: a new pixip result format for model-facing text and `details`, not byte-compatible with `pi_questionare`. Input compatibility is preserved through the widget defaults above.
- Panel lifetime: pass a 15-minute timeout; on timeout or a missing/failed panel return an error result asking the model to use plain text. Only an explicit cancel counts as a dismissal.
- Verification: no real side-by-side session this leg. Evidence is package tests, a fake-host integration test and 390/1280 shots; the README documents the manual side-by-side and uninstall steps.
- Persistence: live surface only; no A2UI surfaces in session history.

---
project: pixip
grilled: true
commit: "77b5eea76ee5fc5cc4b9d2c7a8c4a27a29ce999d"
---

Add a per-question "I need more information" button to the A2UI questionnaire surface. Pressing it ends the tool with a non-error result that tells the model to explain the question and its options in plain text, then ask the questionnaire again.

### Proposed behaviour

- Each question gets a small secondary button next to its prompt: "I need more information".
- The action is distinct from cancel and submit, e.g. `{name:"more_info", context:{questionId, answers:{@path:"/answers"}}}`.
- The tool result is not an error and not a dismissal: it asks the model to elaborate on that question and its options in chat, then re-ask the questionnaire. Include answers already collected so the model can keep them, like the existing deferred "answer in chat" path.
- The questionnaire stays blocking; only the panel tier needs the new action, but the TUI/dialog tiers should not feel broken when the panel is not present.

### Open questions (grill before implementing)

- Should the button appear on text-only questions too, or only on choice questions?
- Carry the current draft answers in the result, or start the re-ask clean?
- Does the model re-ask automatically in the same turn, or wait for the user's reply after explaining?
- Add an equivalent row to the TUI custom UI ("More information") and the dialog fallback, or keep it panel-only?
- Exact result wording, and whether the model should repeat the same question IDs on re-ask.

### Acceptance

- A panel button press returns a model-facing instruction naming the question and any answers collected; it is neither `cancelled:true` nor an error.
- Tests cover decode of the new action plus the result text; `npm run check` green.
- 390/1280 shot of the panel with the extra button.

### Note

The owner also likes ending a questionnaire with a free-text notes question; keep that pattern in the fixture/test questionnaire.

### Grilled decisions

- Every question gets the button, choice and text alike.
- The affected question is **not** answered by pressing it; it becomes the thing the model explains. Answers already collected for the other questions are carried in the result and must not be re-asked. The re-ask starts clean for the affected question only.
- The model explains the question and its options in chat, then **waits for the user's reply**; it re-asks only if still needed after that reply. No auto re-ask in the same turn.
- Parity: A2UI panel button, a "More information" row in the TUI custom UI, and a "More information" option in the dialog fallback.
- Action: `{name:"more_info", context:{questionId, answers:{"@path":"/answers"}}}`. The tool result is non-error, non-cancelled, names the question and its prompt, tells the model to explain in plain text and wait, and lists the other answers already collected.

### Verification

- `extensions/pixip-questionnaire/src/ask.ts` decodes `name: "more_info"`, resolves `context.questionId`, and returns only the other collected answers. Unknown question ids are `lost`, not a dismissal.
- `surface.ts` puts an "I need more information" borderless button on a prompt Row for every question (choice and text), with `{name:"more_info", context:{questionId, answers:{"@path":"/answers"}}}`.
- `index.ts` adds the non-error, non-cancelled `more_info` result text: names the label, prompt and options, tells the model to explain in chat and wait, and lists the other collected answers. TUI and dialog fallbacks return the same result kind.
- `tui.ts` adds a "More information" row; `askWithDialogs` adds a "More information" option for choice and text questions (text asks "Answer here" vs "More information" first when typed input is available).
- Tests: decode/filtering, unknown id, result text, dialog fallback, TUI row, surface action shape and real A2UI processor validation (40 package tests).
- `test/fixtures/a2ui-questionnaire.json` is generated from `buildSurface` and keeps the free-text notes question; dev route opens it with `/?panel=questionnaire`.
- Shots: 390x844 and 1280x900 show the button next to the prompt, panel content-sized, no page scroll.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, root `node --test` (259 pass), and both workspace checks pass.

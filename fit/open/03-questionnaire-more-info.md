---
project: pixip
grilled: true
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

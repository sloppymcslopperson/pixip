---
grilled: true
project: pixip
commit: "2be1706088cf1878d954edff4ddf02edf28c69c7"
---

The per-question “I need more information” control in the questionnaire is a side button that ends the whole questionnaire immediately. Move it to the bottom of each question and make it a per-question answer/toggle, so other questions can still be answered and Submit returns it like any other answer.

### Report

In the A2UI panel the control sits beside the prompt and submits a `more_info` action as soon as it is pressed. That stops the questionnaire and discards the remaining questions, even though the user only wants an explanation for that one question.

### Work

- A2UI surface: remove the side `more_info` button from the prompt row; add a bottom-of-question `CheckBox` labelled “I need more information” bound to `/answers/<id>/moreInfo`.
- Answers: carry `moreInfo` through `normalizeAnswers`, `answerLine`, TUI drafts, dialog fallbacks and details; include it on Submit instead of returning an early `more_info` result.
- Model-facing text: for submitted answers, list any questions marked for explanation and ask the model to explain them in plain text while keeping the other answers.
- Keep the legacy `more_info` action decoder for old panels, but the new surface no longer emits it.
- Update extension tests and README.

### Acceptance

- Pressing/toggling “I need more information” on one question does not close the questionnaire or discard other answers.
- Submit returns the marked question as an answer (`moreInfo: true`) plus all other answers.
- The control renders at the bottom of the question, not beside the prompt.
- TUI and dialog fallbacks behave consistently.
- `npm run check` green; browser smoke verifies the panel stays open and Submit includes the flag.

### Out of scope

- Changing the questionnaire tool schema or adding new question widgets.
- Reworking the panel host/A2UI action protocol.

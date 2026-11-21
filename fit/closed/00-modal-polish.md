---
grilled: true
commit: "9746fee811eb4a5dc3e095dd1230845528d3dd69"
---

Polish every modal and sheet: add a shared x close button, accent/neutral action colors, and field-first input ordering. Dialogs close with x or Escape only, never backdrop click, and Enter submits input/editor dialogs. The same treatment applies to Pi extension dialogs and every pixip `#sheet` overlay.

### Scope

- `handleUiRequest` extension dialogs: `select`, `confirm`, `input`, `editor` (and the existing `notify` path stays a toast).
- Every pixip-owned `#sheet` overlay that already closes through `closeSheet`: archive/delete confirmations, text/session info sheets, directory picker, settings, archived/trash lists, session tree.

### Decisions

- Close affordance: an `×` button at the top-right of the modal header.
- Dismissal: `×` and Escape cancel/close; backdrop clicks do **not** dismiss.
- Colors: primary/confirm actions use the accent color, cancel stays neutral, and destructive actions (delete, archive) use the error/red color.
- Input/editor ordering: field first, title rendered as a secondary hint below the field, then actions (`send`/confirm before `cancel`).
- Keyboard: Enter submits `input`/`editor` (Shift+Enter inserts a newline in the editor); select/confirm have no Enter shortcut; Escape cancels every modal.
- `select` options stay neutral buttons with a neutral cancel; `confirm` shows the yes action in accent and no in neutral.

### Acceptance

- Pi extension dialogs and pixip sheets both show a visible `×` with an accessible label.
- `×`, Escape, and the explicit cancel button all resolve an extension dialog exactly once and close a local sheet.
- Backdrop clicks never close a modal.
- Confirm vs cancel colors are visually distinct, and destructive sheet actions are red.
- Input/editor dialogs render field first, then the title hint, then send/confirm and cancel.
- Enter submits text input/editor content; existing Pi timeout behavior is unchanged.
- Empty title falls back to the request message or method name, as today.

### Files

- `src/client/app.js` (`handleUiRequest`, `confirmSheet`, other sheet builders)
- `src/client/style.css` (shared modal header/close/action styles)
- `test/` for any extracted pure dialog-rendering helper

### Tests

- Cover the pure parts if extracted: action list, ordering, and close semantics.
- `npm run check` green.
- `tools/shot.mjs` at 390 and 1280 with at least one extension dialog and one confirm sheet open.

### Constraints

- Client-only change; no wire protocol, hub, or Pi extension changes.
- Keep the existing response fields (`value`, `confirmed`, `cancelled`) exactly as Pi expects.
- No framework/build step; keep markup and styles small.

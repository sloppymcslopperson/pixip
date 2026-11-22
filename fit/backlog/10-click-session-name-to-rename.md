---
grilled: false
leg: owner-request
project: pixip
---

In an open session, tapping the session name in the top bar should open a rename prompt and save the new name, instead of requiring `/name <name>` from the composer.

### Scope

- Make the session title in the header a tap target only while inside a session.
- Open a small name sheet prefilled with the current name; Enter/save sends the existing `set_session_name` frame.
- Keep the dashboard session row unchanged.
- Respect the existing manual-rename precedence: the automatic first-prompt label must never overwrite it.

### Acceptance

- Tapping the session name in the header opens the rename sheet.
- Saving updates the header immediately and persists through the existing hub/index path.
- Cancel/Escape leaves the name unchanged.
- Desktop and phone layouts still fit; verify with `tools/shot.mjs` at 390 and 1280.
- `npm run check` is green.

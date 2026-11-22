---
grilled: true
commit: "5568dee4b09eb92d917df9371453506554fadd9a"
---

Buttons in modals that overflow should make the button taller so that all text can be viewed (currently it cuts off).

### Decisions

- Scope: every action button/link in `#sheet .sheet-actions`, including extension dialogs, command menus, and model/thinking pickers.
- Wrap to multiple lines: drop `white-space: nowrap` / `text-overflow: ellipsis`, let the row height grow, keep left alignment and existing padding/radius.
- Long unbroken labels (URLs/paths) should wrap via `overflow-wrap: anywhere` so nothing is clipped.
- Preserve current primary/danger styling and hover states.

### Acceptance

- A long-label modal button shows its complete text at 390 px and 1280 px.
- `npm run check` green and `tools/shot.mjs` captures at 390 and 1280.

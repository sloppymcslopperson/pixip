---
grilled: true
commit: "60eccbdaa34982382cb0e66249f37e6b45da313c"
---

jump to newest. A button like in the tui.

### Decisions

- Placement: floating pill above the composer at bottom-right, only over the session transcript, safe-area aware.
- Visibility: hidden while within ~80 px of the bottom; shown when the user scrolls up.
- Label: `↓ jump to newest` with an accessible aria-label; compact on phone.
- Behaviour: click smooth-scrolls to newest and sets `stick = true` so live entries follow again.
- Hidden on the dashboard and on session switch until the user scrolls away from the bottom.

### Acceptance

- Scrolling up reveals the pill; tapping it returns to the newest entry and re-enables auto-follow.
- New entries keep the pill visible until the user jumps.
- `npm run check` green and `tools/shot.mjs` at 390 and 1280.

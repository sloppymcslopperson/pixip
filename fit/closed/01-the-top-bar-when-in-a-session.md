---
grilled: true
commit: e1865cb843b82401cb13de06384ed6a76d36cff3
---

the top bar when in a session should have the text size and reload buttons inside a little "..." menu on the far right side. This should clear up room so that the session name is fully visible.

### Decisions

- Scope: every screen, including the dashboard, not just sessions.
- Form: far-right `…` button opens an anchored dropdown popover; closes on outside click and Escape.
- Contents: A− / percentage / A+ and reload move inside the menu. The status dot, settings, and stop stay outside in the header.
- The freed header width goes to `#titles`, so long session names are fully visible.
- Keep accessibility: `aria-haspopup`/`aria-expanded` on the trigger, focusable menu controls, existing labels.

### Acceptance

- Text size and reload are only reachable through the `…` menu; header room is visibly reclaimed.
- Menu opens/closes correctly at 390 and 1280 px and does not clip off-screen.
- `npm run check` green and `tools/shot.mjs` at 390 and 1280.

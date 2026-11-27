Dragging across the inbox message title selects text, but the click at the end of the drag also toggled the card. A text selection inside the card must suppress the toggle.

### Fix

Before toggling, the card click handler checks the live selection. A non-collapsed selection anchored or focused inside the card is treated as text selection, not a card click. Normal clicks still toggle because the browser clears the selection on mousedown.

### Verification

- Real mouse drag over the subject at 390 and 1280 selects text and leaves the message collapsed; a plain click afterwards still expands it.
- Scripted browser check selects part of the subject and asserts the card stays collapsed.
- `npm run check` green (529 tests, workspaces) and `npm run check:browser` green at both viewports.

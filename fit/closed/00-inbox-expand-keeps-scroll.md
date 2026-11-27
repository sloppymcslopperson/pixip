Expanding an inbox message re-renders the list and loses its scroll offset, so the page jumps back to the top. Keep the `.inbox-list` scroll position across the re-render.

### Fix

Capture the list's `scrollTop` before clearing `#inbox-page` and restore it on the new list. Expansion and collapse now leave the viewport where it was, including when the read-state render lands after the expansion.

### Verification

- Scripted browser check collapses and re-expands a card in a short scroller and asserts the offset is preserved.
- Manual pass at 390 and 1280: scroll the inbox to 400, expand a card, and the list stays at 400 with no horizontal overflow.
- `npm run check` green (529 tests, workspaces) and `npm run check:browser` green at both viewports.

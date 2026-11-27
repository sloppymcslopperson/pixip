A collapsed inbox message should also expand when its body preview is clicked, while clicking the open body still must not collapse it. Make the preview act as a toggle only while collapsed.

### Fix

The card click handler now accepts a body target when the card is collapsed, and ignores body targets when it is expanded. The preview gets a pointer cursor to advertise the affordance.

### Verification

- Scripted browser check expands the message from its preview and still asserts that clicking the open body leaves it open.
- Manual pass at 390 and 1280: preview click expands, expanded body click does nothing, scroll offset survives, no horizontal overflow.
- `npm run check` green (529 tests, workspaces) and `npm run check:browser` green at both viewports.

---
grilled: true
project: pixip
series: chipwitch
title: "Render composer reftag chips inline in the draft, replacing the raw tag text instead of showing a separate chip row above the composer."
---

Composer reftag chips rendered in a separate row above the input, so the raw `[pixip-ref=…]` text stayed visible in the draft. Render each chip inline in a contenteditable composer instead, while keeping the raw tag as the serialized prompt value.

### Problem

The chip-row decision in `closed/chipwitch/20-composer-ref-chips.md` left the tag undisguised in the textarea and put the useful chip somewhere else. That made the chip a preview rather than the reference affordance the composer needs.

### Change

- Replaced the `#input` textarea with a contenteditable composer editor.
- Complete tags are rendered as inline chips at their exact position; surrounding text and newlines stay byte-identical in the serialized value.
- The editor exposes a textarea-compatible `value` facade: every chip serializes back to its raw `[pixip-ref=…]` tag, so sending, drafts, `pixip ref` and optimistic echoes are unchanged.
- Typed and pasted complete tags become chips without moving the caret; pasted text is inserted as plain text.
- Shift+Enter (and Enter on coarse pointers) inserts a newline without the browser's generated block markup.
- Kept the existing two-step chip interaction from `closed/chipwitch/60-reftag-chip-navigation.md`: first tap reveals `×`, second opens the jump confirmation.
- Removed the separate `#reftag-chips` row and its UI map entry.

### Verification

- `npm run check` green: 529 tests, workspace checks and the scripted browser flow.
- Browser-check passes the reftag chip, insert-default and chip-navigation flows at 390 px and 1280 px.
- Manually confirmed at 390 px and 1280 px that the chip renders inside the composer, with no horizontal overflow and the raw tag preserved in the prompt.

### Files

- `src/client/composerEditor.js` (new)
- `src/client/app.js`
- `src/client/composer.css`
- `src/client/index.html`
- `src/client/kernel/ui.js`
- `src/client/reftagResolve.js`
- `test/kernel.test.js`
- `tools/browser-check.mjs`

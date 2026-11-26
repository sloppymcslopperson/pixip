---
grilled: false
project: pixip
series: chipwitch
---

Inside an open session the default action on a message should put its ref tag into the composer rather than copy it, so adding context to a prompt never leaves the transcript.

### Intent

- The tag is the same `[ref=…]` a copy would produce, so the composer chip, the sent message and the CLI all agree.
- Copying stays available for the cross-session case; inserting becomes the in-session default.

### Open

- Which gesture: tap on the block, long-press menu, or a dedicated affordance next to the existing `fork` action.
- Insert position: at the caret, appended at the end, or on a new line; and whether a trailing space follows the tag.
- Whether insertion prefills a sentence ("read this and continue") or leaves the bare tag in an empty composer.
- Behaviour when the composer is disabled or an inline surface request is open.
- Whether inbox messages behave the same from inside a session, given the inbox is currently its own route rather than a sheet.
- Focus and scroll: whether the composer takes focus, and whether an existing draft is preserved untouched.

### Acceptance

- The default in-session action inserts the tag, never sends, and never clears or reorders the existing draft.
- The inserted tag is recognized by the composer chip and by `pixip ref`.
- Copy remains reachable for cross-session use.
- `npm run check` green, plus shots at 390 and 1280.

### Boundaries

- Insert text into the composer only. Never send, never clear or reorder the draft, never move focus away from a draft the user is editing.
- Do not add a prompt field or change what `submit()` does; the insertion is plain text in `ui.input`, followed by the existing resize and send-state refresh.
- Do not take over the reading position: `src/client/scroll.js` stays the only writer of the `#log` position.
- Do not collide with the composer paste listener or the pending-attachment slot.
- Same hot-reload fence as `00-ref-grammar`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `npm run check` green.
- Manual at 390 and 1280: insert into an empty composer, insert mid-draft at the caret, insert with an inline surface request open, and insert twice (two chips, no duplicate text).
- Confirm nothing is sent and the draft is byte-identical apart from the inserted tag.
- Round trip with ticket 40: send the inserted tag, then resolve it with `node bin/pixip.ts ref` against the isolated data dir.
- `node tools/shot.mjs` at 390 and 1280.

### Browser verification (required)

- The gesture is the ticket, so a screenshot is not enough: use the **agent-browser** tool against this worktree's daemon (`http://127.0.0.1:8138/`) to perform the insert on a live block at 390 and 1280, with an empty composer and with a half-typed draft, and confirm by `get text` on the composer that nothing was sent, the draft is intact, and exactly one tag was added.
- Do the same with an inline surface request open, and twice in a row to prove there is no duplicate insertion.
- Scripted coverage in `tools/browser-check.mjs` if the gesture is scriptable; otherwise record the agent-browser transcript as the evidence.

  ```bash
  PIXIP_CHROME=$(ls -d ~/.agent-browser/browsers/chrome-*/chrome | tail -1) npm run check:browser
  ```

- `npm run check` silently skips `check:browser` when `PIXIP_CHROME` is unset. Say explicitly which of the two you ran.

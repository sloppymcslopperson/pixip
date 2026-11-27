---
grilled: true
project: pixip
series: chipwitch
---

Inside an open session the default action on a message now inserts its ref tag into the composer instead of copying it, so adding context to a prompt never leaves the transcript. Copying stays reachable from the same action menu for cross-session use.

### Decisions

- Gesture: the one-tap `#` corner action inserts the tag in an open session. The `…` menu gains `copy ref` beside the existing `copy with text`, so copy remains reachable. The `fork` item is unchanged.
- Insert position: append on a new line before the tag only. Do not add a leading newline when the composer is empty; the empty draft becomes exactly the bare tag. No trailing newline or trailing space. Put the caret after the inserted tag.
- Prefill: bare tag only. Never invent prompt prose.
- Gates: insert only when the composer is usable — enabled and no inline blocking surface request open. Otherwise copy the tag to the clipboard and toast that it was copied.
- Inbox: inbox card `#` stays copy. Only transcript message actions change in this ticket.
- Focus: focus the composer and place the caret after the tag.
- Draft preservation: never send, clear or reorder the draft. Everything outside the appended tag stays byte-identical.
- Duplicate inserts are allowed and produce one chip per occurrence; the existing composer dedupe controls the chip row.

### Acceptance

- The in-session `#` action inserts the tag, never sends, and never clears or reorders the existing draft.
- The `…` menu still offers copying: `copy ref` copies the bare tag and `copy with text` keeps the excerpt behavior.
- With a disabled composer or an open inline surface request, the action copies the tag and toasts instead of inserting.
- The inserted tag is recognized by the composer chip and by `pixip ref`.
- `npm run check` green, plus shots at 390 and 1280.

### Boundaries

- Insert text into the composer only. Never send, never clear or reorder the draft, never move focus away from a draft the user is editing.
- Do not add a prompt field or change what `submit()` does; the insertion is plain text in `ui.input`, followed by the existing resize and send-state refresh.
- Do not take over the reading position: `src/client/scroll.js` stays the only writer of the `#log` position.
- Do not collide with the composer paste listener or the pending-attachment slot.
- Staff the in-session gate through existing client state (`state.info`, the inline surface status) rather than adding protocol.
- Same hot-reload fence as `00-ref-grammar`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `npm run check` green.
- Browser-check coverage in `tools/browser-check.mjs`: insert into an empty composer, insert into a half-typed draft, insert with an inline surface request open (copy + toast), insert twice, and confirm the textarea payload contains exactly the expected tags and the draft is otherwise untouched.
- Manual at 390 and 1280: same cases; confirm nothing is sent.
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

### Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, the reftag/render/import tests, and `PIXIP_CHROME=… npm run check:browser` passed. Full `npm run check` was blocked only by the known daemon tests when run inside pixip (`PIXIP_INSIDE`/`PIXIP_SESSION_ID` make stop behave as restart); every non-daemon suite passed.
- Agent-browser against `http://127.0.0.1:8138/`: at 390 and 1280, empty-composer insert produced exactly one bare tag; half-draft insert produced `draft\n[tag]`; a second insert appended another line; nothing was sent until the explicit send. The sent tag resolved with `node bin/pixip.ts ref … --data-dir ./tmp/t50`.
- A live block tag resolved the composer chip through the painted block (backed by a new browser-check assertion), so live and snapshot inserts both avoid `unresolved`.
- Inline A2UI fixture open: insert left the composer empty, copied the tag, and showed `composer unavailable — ref tag copied`.
- `tools/shot.mjs` at 390 and 1280: no overflow, no browser errors.

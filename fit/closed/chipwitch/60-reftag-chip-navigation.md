---
grilled: true
project: pixip
series: chipwitch
---

Optional follow-up to ticket 20: composer reftag chips gain a two-step jump gesture. The first tap exposes × and primes the chip; the next click, if it is the same chip, opens a "jump to message?" confirm dialog. There is no return-to-composer behavior after a jump.

### Status

- Confirmed wanted by the owner on 2026-11-21 and grilled in this batch.
- The ticket originally proposed first-tap navigation and second-tap return. That is superseded by the decisions below.

### Decisions

- First tap on a chip body: expose the × removal button and prime that chip. No navigation yet.
- Second click must be on the same chip body: it opens an app confirm dialog titled `jump to message?` with `Jump` and `Cancel`.
- Priming is dropped if the next click is not on that same chip. Another chip, the transcript, a button or empty space clears the prime; the next first tap starts over.
- `Jump`: navigate to the referenced target, scroll it into view and flash it briefly. `Cancel`: close the dialog and leave the reading position alone.
- Highlight: a brief CSS flash (about 1.5 s), then remove the class. No layout shift.
- Missing target in the current session: automatically request earlier transcript windows until the entry is found. If the start of the session is reached without finding it, toast `message not found`.
- Cross-session history ref: open that session at the referenced entry and use the same paging, scroll and flash behavior.
- Inbox ref: open the inbox page.
- No return behavior after a jump: do not add a second-tap return, saved scroll offset or back control. The reader uses normal scrolling or the existing `jump to newest`.
- Only × removes the token. Removal must still update the textarea and chips as it does today.
- Unresolved or malformed chips stay inert and never open the dialog.

### Constraints

- Display/navigation only: never rewrite the textarea, `state.entries`, or the JSONL.
- Do not add a hub route or protocol field; navigation uses existing frame data and routes.
- Respect the client import guard and the hot-reload fence from `00-reftag-grammar`.
- Keep `src/client/scroll.js` as the only writer of the `#log` position where practical; jump/highlight logic may scroll deliberately but must cooperate with `state.stick` and `updateJump`.
- If the target block is not painted yet after loading, wait for/repaint and then scroll; do not mark the jump complete before the block exists.

### Testing

- `npm run check` green, including `check:browser` with `PIXIP_CHROME`.
- Scripted browser coverage: first tap exposes × without jumping; a click elsewhere drops the prime; second tap on the same chip opens the dialog; Cancel leaves position; Jump scrolls and flashes; × removes only the token; cross-session opens the owning session and targets the entry; inbox chip opens the inbox; missing entry loads earlier and finally toasts.
- `node tools/shot.mjs` at 390 and 1280 because the dialog and chip affordances change.
- Run the agent-browser pass against this worktree's daemon at 390 and 1280 for the two-tap gesture, dialog and jump.

### Verification

- Implemented in `src/client/reftagJump.js` with the primed-chip state in `src/client/reftagResolve.js`; only existing routes/frames are used.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, reftag/render/import tests, and `PIXIP_CHROME=… npm run check:browser` passed. Full `npm run check` remains blocked only by the known daemon tests when run inside pixip (`PIXIP_INSIDE`/`PIXIP_SESSION_ID` turn stop into restart); non-daemon suites are green.
- Scripted coverage now exercises: first tap exposes × with no dialog; outside click drops the prime; second tap opens `jump to message?`; Cancel leaves the route; Jump pages to h0 and flashes; × removes only the token; missing entry eventually toasts; inbox chip opens the inbox; cross-session chip opens the peer session and flashes h319.
- Agent-browser against `http://127.0.0.1:8138/`: at 390 and 1280 the first tap opened the ×, the second opened the confirm sheet, and Jump produced `class="block user reftag-flash"` on the target. Screenshots captured for both widths.
- `tools/shot.mjs` at 390 and 1280: no overflow and no browser errors.
- A valid entry outside the loaded window now resolves as a name-only chip instead of `unresolved`, so the jump can page to it; unresolved/malformed tags still never open the dialog.

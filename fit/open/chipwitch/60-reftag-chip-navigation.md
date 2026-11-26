Optional follow-up to ticket 20: tapping a composer reftag chip navigates to the referenced message, and a second tap returns to the session-local message being composed. Only the × button removes the token.

### Status

- Deliberately optional and un-grilled. Confirm with the owner that it is still wanted before working it.
- Not part of the chipwitch ref run; it sits at the end of the open leg as a candidate.

### Behavior if accepted

- First tap on the chip body: if the target is in the current session, scroll to and briefly highlight the block; if it is another session, open that session at the referenced entry.
- Second tap (or a back gesture on the chip): return to the session and scroll position where the composer was.
- The × button remains the only removal action.
- Inert chips in ticket 20 must not gain this behavior until this ticket is taken.

### Constraints

- Display/navigation only: never rewrite the textarea, `state.entries`, or the JSONL.
- Do not add a hub route or protocol field; navigation uses existing frame data and routes.
- Respect the client import guard and the hot-reload fence from `00-reftag-grammar`.

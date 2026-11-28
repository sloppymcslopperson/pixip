---
project: pixip
---

An unanswered select, confirm, input, editor, or panel request is kept only in hub memory, so a hard restart loses the question even though the agent is still waiting. Write every unanswered request to disk when it arrives and turn it into the existing re-ask card after a restart.

### Current behavior

- `live.pendingUi` is an in-memory map and is cleared on child exit.
- Only a timed-out request is written under `<data-dir>/pending-ui/`; a live request has no recovery record.

### Scope

- Persist a record as soon as a blocking UI request arrives, using the existing pending-ui record shape and atomic temp+rename writes.
- Remove the record when the request is answered, cancelled, or otherwise resolved.
- On attach, show a re-ask card when the request is no longer live in the child; never double-show a request that the live child still holds.
- Keep the existing timeout, more-time, and re-ask flow working unchanged.

### Acceptance

- Force a restart with a pending confirm: after reattach the user sees the re-ask card and can answer it.
- Answering or cancelling removes the persisted record.
- A still-live request is not duplicated by the recovered record.
- Tests cover write-on-arrival, answer removal, restart recovery, and the timed-out path.

### Files

`src/pendingReask.ts`, `src/hubLive.ts`, `src/hubSession.ts`, `src/client/surface.js`, `test/`.

### Edge cases

- Several pending requests preserve their original order.
- Preserve an unsent A2UI draft with the record.
- A crash during the write must not leave a partial JSON file.
- An answered or cancelled request must never come back as a re-ask.

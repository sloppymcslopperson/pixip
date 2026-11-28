---
project: pixip
---

Queued steering and follow-up messages live only in the Pi child, so a forced restart or child respawn loses text the user already sent. Persist the current queue per logical session and restore it as unsent composer text when the session comes back.

### Current behavior

- `queue_update` is forwarded verbatim and only the client keeps queue chips; the hub does not retain the queue.
- A `/pixup-restart`, `respawnSession`, or unexpected child exit clears the queue with the child.

### Scope

- Track the latest complete `queue_update` queue per logical session under `<data-dir>/queue/`.
- On attach or restart, when the live child reports an empty queue and a persisted queue exists, send the persisted texts to the client as unsent composer text or chips.
- Do not auto-send restored messages. The user decides whether to resend or clear them.
- Remove the persisted record on `clear_queue`, on an empty `queue_update`, and when the client restores or sends the texts.

### Acceptance

- Force a restart with two queued messages: after reconnect both appear, and neither is sent twice.
- A hub reload that keeps the same live child does not duplicate the queue.
- `clear_queue` also clears the persisted record.
- Tests cover queue replacement, restart restore, and the no-duplicate path; browser check at 390 and 1280 for the restored chips.

### Files

`src/hubLive.ts`, `src/hubControl.ts`, `src/wire.ts`, `src/client/transcript.js`, `test/fixtures/fake-pi.mjs`, `test/`.

### Edge cases

- The last complete `queue_update` wins when several arrive while a client is disconnected.
- Archive or delete must remove the persisted queue for that session.
- `queue_update` carries text only; do not claim image attachments are restored unless the hub also records them.

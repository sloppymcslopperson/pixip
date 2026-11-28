---
project: pixip
---

The inbox is one-way: an agent can ask the user something, but a reply cannot wake or resume the waiting session without holding a child. Add a persisted wait that a later inbox reply can resolve, with an explicit timeout and cancel path.

### Current behavior

- A blocking dialog holds the Pi child open.
- An inbox message can be read or replied to in the composer, but it cannot resolve a waiting agent by itself.

### Scope

- Persist a wait record keyed by logical session and wait id, with the question, created time, optional expiry, and reply options.
- Add an inbox action that resolves the wait by steering or resuming the sender session, or starting it when stopped.
- Add listing and cancellation for outstanding waits.
- On expiry, produce a re-ask card or a new inbox message instead of silently dropping the wait.

### Acceptance

- An agent asks a question, the child detaches or stops, the user replies hours later, and the agent continues exactly once.
- A duplicate reply is idempotent.
- Cancel and expiry do not resume the session.
- Tests cover resolve, duplicate, cancel, expiry, and a session that is stopped when the reply arrives.

### Files

`src/inbox.ts`, `src/hubInbox.ts`, `src/hubControl.ts`, `src/wire.ts`, `src/client/inbox.js`, `src/client/session.js`, `test/`.

### Edge cases

- Session archived or deleted while the wait is outstanding.
- Several waits on one session.
- Reply while the session is busy: queue a steer or follow-up according to the wait's reply mode.
- Respect the existing inbox token and unauthenticated-UI posture.

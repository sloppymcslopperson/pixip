---
project: pixip
---

An unexpected child exit marks the session error and drops the live child, with no automatic reattach and no clear way to continue an interrupted turn. Reattach once, show what was interrupted, and offer a user-gated continue.

### Current behavior

- `onExit` deletes the live session, clears pending UI, sets `error`, and broadcasts `pi exited`.
- The JSONL remains, but the hub does not respawn or offer a continuation.

### Scope

- On an unexpected exit, respawn once through the existing reattach path, with a bounded retry count and backoff.
- Detect an unsettled turn from the transcript or child state and mark the session as interrupted rather than silently idle.
- Add a `continue` frame and client action that sends exactly one continuation prompt after the user chooses it.
- Do not replay tools with external side effects automatically.

### Acceptance

- Kill a child mid-turn: the session reattaches, the transcript shows an interrupted marker, and Continue sends one prompt.
- A repeatedly crashing child stops after the retry limit and stays in an error state without a loop.
- An intentional stop, reload, or daemon shutdown does not trigger recovery.
- Tests cover unexpected exit, retry limit, continue once, and intentional shutdown.

### Files

`src/hubLive.ts`, `src/hubControl.ts`, `src/wire.ts`, `src/client/sessionEffects.js`, `src/client/footer.js`, `test/fixtures/fake-pi.mjs`, `test/`.

### Edge cases

- Crash during startup, idle, bash, or a pending UI request.
- Session archived or deleted while the child is down.
- A continuation must not duplicate a turn that Pi already completed before the crash.

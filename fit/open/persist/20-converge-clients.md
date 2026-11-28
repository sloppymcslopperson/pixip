---
project: pixip
---

Two clients on one session keep independent optimistic state, so a message sent from one can look missing or duplicated on the other. Add a hub-owned pending-input echo and converge clients on the same session state, building on the parked-session store.

### Current behavior

- Every socket is independent; a prompt is echoed optimistically only in the sending client.
- The other client sees Pi's eventual user echo but not the in-flight send or queued steer.

### Scope

- Hub broadcasts an accepted prompt or steer with a stable request id and logical session id.
- Clients dedupe their own echo by request id and add the pending block for other clients.
- Reconcile the pending block with Pi's user echo and `queue_update` so only one representation remains.
- Build on `open/09-background-session-state.md` for per-session client state; do not duplicate that store work.

### Acceptance

- Tab A sends a prompt; tab B shows it within one frame and A does not duplicate it when Pi echoes.
- A queued steer appears on both clients with the same text and order.
- Reconnect does not duplicate a pending or delivered input.
- Tests cover the pure dedupe reducer, a two-client integration, and the browser flow at 390 and 1280.

### Files

`src/hub*.ts`, `src/wire.ts`, `src/client/transport.js`, `src/client/frames.js`, `src/client/transcript.js`, `test/`.

### Edge cases

- Two clients send identical text; ids must distinguish them.
- A rejected prompt is removed from both clients.
- Rekey, restart, and parked-socket resume must invalidate stale pending blocks.

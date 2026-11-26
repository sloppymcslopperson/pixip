---
project: pixip
---

Implement `/reload` as a user-only, daemon-wide in-place reload: refuse while any session is non-idle, then re-read assets and reload every live child, with an ephemeral transcript notice. This slice covers assets and Pi resources only; daemon TypeScript follows in `07-hub-generation-reload`.

### Gate

- Busy = any session not in `idle` or `stopped`, plus a non-empty `pendingUi`, plus a running `bashId`, plus a turn without `agent_settled`.
- A red/`error` dot does not block; it is named in the report.
- Refusal lists every blocking session with its reason; nothing is reloaded.

### Behaviour

- All live sessions reload, not just the caller's.
- Transaction: assets swap and child reloads happen together; a failure leaves the old state and reports the error.
- Ephemeral local row in the transcript/history, never written to the JSONL.
- `/reload` leaves TUI-only in `src/client/commands.js` and becomes a real builtin sending a control frame over the session socket.
- `pixip reload` CLI over SIGUSR1 (local only, pid from the state file); from inside an agent it refuses with `reload is user-only, please ask your user to run the /reload command`, exit 2.
- `pixip-pi-host` gains a `reload` capability and command that calls `session.reload()`; system-pi children answer "reload requires respawn" (see `04-respawn-child`).

### Acceptance

- Busy session produces the explanatory refusal and no side effects.
- All idle: assets and every live child reloaded, notice shown to every connected client.
- Editing an extension and an asset, then `/reload`, shows both without a daemon restart.
- Notice is not persisted; tests cover the gate and the rollback.

### Depends

- `03-pi-host-by-default`
- `04-respawn-child` for the system-pi case

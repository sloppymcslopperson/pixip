---
project: pixip
grilled: true
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

### Decisions (grilled)

- `/reload` becomes a real builtin in `src/client/commands.js` (remove it from `TUI_ONLY_COMMANDS`) and sends a `reload` control frame over the session socket.
- User-only is enforced with a browser nonce: a per-daemon random nonce is embedded in served `index.html` (meta tag) and required in the `reload` control frame. Missing/stale nonce is refused and logged. The nonce rotates on every successful reload and at daemon start.
- `pixip reload` stays a SIGUSR1 trigger, pid from the state file, local only. Because SIGUSR1 is one-way, the daemon writes `<data-dir>/pixip.reload.json` with status, blockers and per-child results; the CLI polls that file until it changes, prints the result, and exits 0 on success, 1 on busy/refusal/timeout, and 2 with the exact text `reload is user-only, please ask your user to run the /reload command` when `PIXIP_INSIDE`/`PIXIP_SESSION_ID` is set.
- Gate exactly as written: any live session not `idle`/`stopped`, non-empty `pendingUi`, `bashId`, or an unsettled turn blocks; `error` does not block but is named. Refusal lists every blocker and causes no asset swap, nonce rotation, reload or page reload.
- Scope: reuse the existing soft refresh (assets, per-session command policy, index, client command catalog), then reload every live child. Host children use a new `reload` command; system-pi children are auto-respawned via `04-respawn-child` first.
- Failure policy: preflight the gate and asset/config reads first. After that, child reloads are best effort: a failing child is reported, other children continue, assets stay new, and the result is not reported as full success. Preflight failure leaves the old state untouched.
- Notice: new ephemeral broadcast frame; each client renders one local transcript row, stores the text in `sessionStorage` per session, then reloads the page to pick up new code and nonce and re-renders the row once after reconnect. Never written to the JSONL.
- Every connected client gets the forced page reload after a successful reload, not only the caller.
- `pixip-pi-host` gains `reload` in `capabilities` and a `reload` command calling `session.reload()`. A system-pi child still answers `reload requires respawn` if a direct reload is attempted, but `/reload` migrates it instead.
- Tests: gate/refusal has no side effects, nonce rejection, preflight rollback, best-effort partial child failure, CLI exit codes 0/1/2, notice frame, fake-host `reload` support, and client renderer tests for the ephemeral row.

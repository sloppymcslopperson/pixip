---
project: pixip
---

A background `restart --force` launched from an agent session killed another in-flight agent. Reloads and restarts are now strictly user-requested: agent-session restarts refuse, `--force` is accepted only from a shell outside pixip, and `SIGHUP` is ignored.

### Incident

While loading the report-button and `reports` category changes, an agent scheduled `pixip restart --force` from inside a pixip session. The detached helper replaced the daemon at 02:31 and killed a turn another agent was running. The session JSONL survived and the logical session reattached, but the in-flight turn was lost.

### Changes

- `pixip restart` from inside a pixip session now exits 2 with a user-only message. Replacement from a session goes through the browser's nonce-gated `/pixup-restart` card.
- `--force` remains available from an external shell, where it is an explicit user action. It is rejected from inside a session, and the busy-session gate only yields to that external `--force` or `--when-idle`.
- `SIGHUP` is logged and ignored instead of running a soft refresh.
- `AGENTS.md` now forbids agent-initiated reloads/restarts and background scheduling.
- README, ARCHITECTURE, CLI help and the daemon tests were updated to the new contract.

### Verification

- `npm run typecheck`, lint, Prettier and the full test suite pass: 502 tests, 0 failures.
- The daemon was **not** restarted for this ticket. These guards take effect on the next restart the user explicitly requests.

---
project: pixip
---

Add `/pixup-restart`, deliberately distinct from `/reload`: a full daemon replacement through the existing detached restart helper, user-only, refusing with a session list unless the user confirms force.

### Behaviour

- Client builtin `/pixup-restart`; reuses `pixip restart --detached`, SIGUSR2, the `restarting` frame and the durable reconnect cursor. No new lifecycle machinery.
- Default refuses when any session is non-idle, naming each one; a force confirmation interrupts turns and proceeds.
- `/reload` never forces.
- Ephemeral transcript row after reconnect: daemon restarted (pid, uptime).
- Command summary states the difference from `/reload` so the two are not confused.

### Acceptance

- Force path restarts the daemon and the browser reconnects with the cursor intact.
- Refusal path changes nothing and explains which sessions block.
- `pixip restart` from inside an agent refuses with `restart is user-only, please ask your user to run the /pixup-restart command`, exit 2.
- Browser check at 390 and 1280 for the control and notice.

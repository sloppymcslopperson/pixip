---
project: pixip
grilled: true
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
- `pixip stop` from inside a session refuses with a user-only message naming `/pixup-restart`, exit 2; `pixip restart` still works from inside through the detached helper.
- Browser check at 390 and 1280 for the control and notice.

### Decisions (grilled)

- User-only gate is browser-only: `/pixup-restart` is the user-only control, while `pixip restart` keeps working from inside a session through the detached helper. `pixip stop` from inside now refuses (exit 2) with a user-only message naming `/pixup-restart`, instead of silently becoming a forced restart.
- Force UX: an inline confirm card in the transcript lists every blocking session; the Force button re-sends the same request with force. No browser `confirm()` and no second typed command.
- Gate: non-idle/stopped/error plus pending UI and running bash. An unsettled thinking turn alone does not block.
- Transport: new `restart` WS frame carrying the reload nonce. The daemon spawns `restart --detached`; the browser reconnects with its durable cursor, then fetches `/health` for `pid`/`startedAt` and paints `daemon restarted (pid, uptime)` as an ephemeral row.
- Hot set: after a restart the dashboard must look unchanged in which sessions are hot/warm. The new daemon reattaches the logical sessions that were live before the restart (persist the live set on the way down, reattach on startup) instead of leaving them stopped until a browser reconnects.
- `/reload` never forces: keep the current refusal path and do not accept a force argument there.
- Command summary states the difference: `/reload` swaps assets/policy/child code in place; `/pixup-restart` replaces the daemon process.
- Steering-message pause/resume around the restart is deferred to a follow-up ticket and is not part of 06.

### Tests

- Force path restarts the daemon, the browser reconnects with the cursor intact, and the restarted daemon reattaches the pre-restart live set.
- Refusal path changes nothing and names the blocking sessions; pending UI and running bash block, an unsettled thinking turn alone does not.
- `pixip stop` from inside a session exits 2 with the user-only message; `pixip restart` from inside still works.
- Browser check at 390 and 1280 for the inline confirm card and the post-reconnect notice.
- `npm run check` green. Browser screenshots were unavailable on this box because `PIXIP_CHROME` is unset; the scripted browser check skipped.

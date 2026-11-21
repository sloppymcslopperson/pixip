---
grilled: true
commit: "3b49bdc"
---

A session that triggers `pixip restart` through its own bash tool loses its websocket and Pi child when the old daemon stops, so the browser drops mid-turn and cannot prove the session will come back. Make self-issued restarts reconnect the issuing session instead of ending it silently.

### Problem

`pixip restart` runs its stop/start in a detached helper so the CLI survives, but the old daemon still terminates the Pi child for the calling session. The browser sees a dead socket, backs off, and reconnects to the new daemon, yet nothing in the UI explains the restart or defines what happens to the in-flight turn. If the client reconnects after the child died mid-response, it can miss events, leave a half-rendered turn, or appear stuck.

### Decisions

- **In-flight turn:** abort it. The old child is stopped by the daemon shutdown; the transcript paints a visible system notice that the turn was interrupted by the restart. The composer returns ready after reconnect. Do not wait for the calling turn and do not silently continue.
- **Signal:** the old daemon broadcasts an explicit `restarting` frame to live session sockets before shutting down. The client enters a `restarting` state and reconnects; it never has to infer the reason from a bare socket close.
- **Reattach:** the new daemon auto-reattaches the same logical Pi session on reconnect (spawns its child), so the user lands back in the live session. Reconnect uses the durable entry cursor and must not duplicate transcript entries.
- **Crash coverage:** the same client reconnect/restarting treatment covers unexpected daemon crashes too; the explicit frame is used when the restart is known, with the existing socket-close path as the fallback.
- **Scope of state:** restarting is visible on the affected session view; the dashboard keeps its normal session list and recovers from the `sessions` snapshot after reconnect.
- **Files:** `bin/pixip.ts`, `src/hub.ts`, `src/server.ts`, `src/client/app.js`, `src/client/style.css`, `test/daemon.test.ts`, and the daemon/restart section of `ARCHITECTURE.md`.

### Acceptance

- `pixip restart --force` issued from a session does not leave the browser on a dead socket.
- The client shows `restarting`, reconnects to the new daemon, and reattaches the same logical session with no duplicated transcript entries.
- An interrupted turn is visible and never silently continues as if nothing happened.
- `npm run check` is green, with a daemon test that asserts the reconnect and reattach path; responsive behavior is checked at 390 and 1280.

### Open Questions

None after grilling.

---
grilled: true
commit: "3755883"
---

pressing "new" should instantly open a new session window, with a disabled prompt input box and a little message in the history view until the agent is ready

### Decisions

- **Trigger:** the dashboard cwd form's `new` button only. The in-session `/new` command keeps its current behavior.
- **Mechanism:** client-side pending view. On submit, immediately show the session view under a synthetic pending route with the history area showing `starting session…` and the composer visibly disabled. The existing `create` websocket frame runs in the background; when the daemon replies with `opened`, replace the URL with the real session id and connect normally. No protocol change.
- **Pending state:** the composer cannot send while pending. History shows a clear starting message. If spawning fails, show the error in the history view, keep a back/dashboard affordance, and do not leave a ghost session or navigate to a dead id.
- **Ready:** once the real id is open, the normal snapshot/status path enables the composer when the session is ready; no extra ready state in the hub.
- **Tests:** cover the pending rendering in `test/` at the pure render level, and check `tools/shot.mjs` at 390 and 1280. No daemon integration test unless the mechanism changes.
- **Files:** `src/client/app.js`, `src/client/render.js` (pending history row), `src/client/style.css`, `test/render.test.*` (or the existing pure render test file), and the client section of `ARCHITECTURE.md`.

### Acceptance

- Pressing `new` switches to the session window in the same interaction, before Pi has started.
- The history view shows the starting message and the prompt input is disabled until the session is ready.
- The window lands on the real session id with no duplicate connection, and a failed spawn shows an error instead of a ghost session.
- `npm run check` is green and responsive behavior is checked at 390 and 1280.

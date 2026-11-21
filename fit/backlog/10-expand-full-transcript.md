The transcript is windowed (tail 200 entries plus "load earlier" windows), so there is no way to pull the entire session into the client at once. The owner asked for an explicit way to load the whole transcript when they want it.

### Goal

An explicit, human-triggered "load entire transcript" action that fetches every remaining entry of a session, so a long session can be read end to end without clicking "load earlier" repeatedly.

### Scope (from grilling 2026-11-21)

- Explicit opt-in only: never automatic, never on first paint.
- Must not regress the 300 ms cold-attach budget when unused.
- Follows the windowed transcript work in `01-jsonl-first-paint` (`load earlier` frame type, client window state).

### Open questions

- Hard cap or streaming fill for very large sessions (17 MB+)?
- Confirmation prompt with an estimated size before loading?
- Where the action lives (session menu vs transcript header).

### Files (expected)

`src/server.ts`, `src/wire.ts`, `src/client/app.js`, `ARCHITECTURE.md`.

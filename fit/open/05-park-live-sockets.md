---
project: pixip
---

Park green/yellow session sockets when switching away so returning needs no WebSocket handshake. Paint the cached transcript immediately, mute the parked stream, and resume with a cursor delta when the session becomes active again.

### Context

Measured from the owner's phone over cell: HTTP RTT median **123 ms** (p95 266, max 490), WebSocket handshake median **239 ms**. Loopback baseline is 4.7 ms / 13.6 ms. Today switching closes the socket and pays the handshake before the bounded window can arrive; the hub keeps the child alive, but the subscription does not.

### Scope

- Keep the dashboard session-less socket separate from session sockets.
- Park only sessions whose `info.state` is `idle` or `busy`; close on `stopped`/`error`.
- Active socket plus up to two parked sockets, LRU. Use a code constant; no UI.
- Parking **mutes** the session stream (no event or list frames) so a busy yellow session does not spend cell data.
- Returning: repaint from `sessionCache` synchronously, activate the warm socket, send `resume since=<lastEntryId>`, and apply the delta when it arrives.
- A parked socket that closes is evicted silently; only the active socket triggers the existing reconnect/backoff path.

### Protocol

- Add client -> hub `park` (no fields) and `resume` (`{ since }`).
- `park`: unsubscribe this socket from the session and list watchers, keep the WebSocket open.
- `resume`: replay policy/addon/pending re-asks as needed, request `hub.snapshot(id, undefined, since)`, send a `resume` snapshot through the existing buffer/coverage path, then re-subscribe.
- Additive commands; keep `WIRE_VERSION` unless an existing frame changes shape.

### Client

- `src/client/transport.js`: replace the single `state.ws` with a keyed connection manager; route frames as `(sessionId, frame)`.
- `src/client/session.js` and `src/client/dashboard.js`: park on switch-away instead of closing; do not call `connect(null)` while a live socket can be parked.
- `src/client/sessionCache.js`: keep info/footer/policy/commands/addon/queue and the last entry id for a parked session.
- `src/client/frames.js`: background control frames update the cache only; never touch the active DOM.

### Server

- `src/server.ts`: split the attach path into attach/park/resume per socket; keep the active Pi id and subscriptions mutable.
- Reuse `hub.attach` (returns the existing child, no spawn), the bounded `hub.snapshot` delta, and pending-UI replay.
- No hub-side history buffering, no shim, no private extension API, no plugin change.

### Acceptance

- Switch away and back to a green/yellow session opens no new WebSocket and logs no new `attached` line.
- The cached transcript paints before any network work; the delta arrives at about one RTT, not a handshake.
- While parked, the server sends no session events for that socket (assert by frame count).
- A parked session that stops/errors, or falls past the LRU cap, closes cleanly.
- Tests: connection-manager unit, server park/resume, browser check for switch-away/back, and a switch-away/back case in `tools/reconnect-bench.mjs`.
- Update `ARCHITECTURE.md` with the park/resume path and the cell measurements.

### Edge cases

- Resume cursor rejected: fall back to the bounded JSONL window through the existing path.
- Pending UI: replay from the hub cache on resume; never answer a parked request.
- Rekey `/new` from another tab while parked: invalidate and close that parked socket; activation reconnects normally.
- Daemon restart: all sockets close; evict parked entries; the active reconnect path is unchanged.
- Status changes while muted: refresh from the resume snapshot/status.

### Files

`src/client/transport.js`, `src/client/session.js`, `src/client/dashboard.js`, `src/client/sessionCache.js`, `src/client/frames.js`, `src/client/sessionEffects.js`, `src/server.ts`, `src/wire.ts`, `src/hubControl.ts`, `test/`, `tools/reconnect-bench.mjs`, `ARCHITECTURE.md`.

### Out of scope

- Background event application and per-session client state; tracked separately.
- A multiplexed single socket, a warm child pool, or Pi changes.

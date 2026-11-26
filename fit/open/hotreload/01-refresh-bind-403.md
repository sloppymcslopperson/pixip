---
project: pixip
---

`POST /api/refresh` answers 403 whenever the daemon is bound to a non-loopback address: `isLoopback` compares `req.socket.remoteAddress` against 127/8 and a local client reaching the bound address presents that address, so `pixip refresh` fails on this checkout. Make refresh work on every supported bind without weakening the endpoint.

### Steps

- `src/server.ts:84` `isLoopback`: accept a request whose `remoteAddress` equals the configured `options.host` (normalize `::ffff:` forms).
- Keep rejecting genuinely remote peers.
- Leave the endpoint's other policy unchanged.

### Acceptance

- `pixip refresh` against a daemon bound to `100.42.42.1` returns `{reloaded:[...]}` instead of `{"error":"refresh is loopback-only"}`.
- A request from another host is still refused with 403.
- Regression test covering both cases.

### Notes

- Found while planning the reload path; independent of it, can ship alone.
- Path: `open/hotreload/01-refresh-bind-403.md`

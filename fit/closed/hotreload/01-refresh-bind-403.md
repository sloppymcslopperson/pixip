---
project: pixip
grilled: true
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

### Grilling answers (recorded 2026-11-25)

- Local means 127/8, `::1`, or `remoteAddress` exactly equal to a concrete configured bind host, normalized for `::ffff:` forms.
- Wildcard binds (`0.0.0.0` / `::`) keep the old loopback-only policy; no local-interface discovery.
- Genuinely remote peers still get 403; the endpoint's other policy is unchanged.
- Regression tests are unit tests against an exported pure guard, covering loopback, exact host, `::ffff:` normalization, wildcard bind, and a foreign peer.

### Implementation (2026-11-25)

- `isLoopback(req, host)` now accepts 127/8, `::1`, or a `remoteAddress` equal to the concrete bind host after stripping `::ffff:` on either side.
- Wildcard binds (`0.0.0.0`, `::`) and an empty host stay loopback-only; the refresh endpoint policy is otherwise unchanged.
- `test/refresh.test.ts` covers loopback, exact host, both `::ffff:` directions, a foreign peer, and the wildcard matrix.
- Verified manually: `pixip refresh` against a daemon bound to `100.42.42.1` returned `reloaded assets, config, index, commands (1 total)`. `npm run check` green.

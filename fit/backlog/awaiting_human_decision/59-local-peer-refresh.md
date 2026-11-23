---
grilled: true
project: pixip
---

`/api/refresh` only accepts loopback peers, so `pixip refresh` is refused when the daemon binds a non-loopback address such as the VPN address `100.42.42.1`. Add a local-peer check that accepts the bind address and local interface addresses, and use it for the refresh endpoint.

### Evidence

- Running daemon: pid 251081, `--host 100.42.42.1 --port 8137`, data dir `tmp/trial`.
- `tmp/trial/pixip.log` shows `refresh refused from non-loopback peer 100.42.42.1` and `...100.42.42.253`.
- `src/server.ts` `LOOPBACK = /^(127\.|::1$|::ffff:127\.)/` rejects both.

### Scope

- Replace the loopback-only predicate with `isLocalPeer(req, boundHost)` in `src/server.ts`: true for loopback, for `remoteAddress === boundHost`, and for addresses of local interfaces. Keep remote peers refused.
- Apply it to `POST /api/refresh`. Do not loosen anything else.
- Keep the behaviour identical for a `127.0.0.1` bind.

### Acceptance

- `pixip refresh` succeeds against a daemon bound to `100.42.42.1` from the same host, and still fails from another machine on the tailnet.
- Tests cover loopback accept, bind-address accept, and a non-local address reject without a real network dependency (inject/stub the remote address).
- `npm run check` green.

### Grilling

Further grilling is welcome for how local interface addresses are enumerated. The decisions above are settled.

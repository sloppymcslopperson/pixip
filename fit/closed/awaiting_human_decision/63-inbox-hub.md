---
grilled: true
project: pixip
commit: "8166ddaac4b37b48d1252ce9342f421dcce84169"
---

Add a durable message inbox that agents can post to and the user can read from the dashboard; messages belong to the data dir and outlive sessions. This ticket is the hub half: store, REST, websocket badge updates, CLI, child env, and the auth seam.

### Settled decisions

- Storage: `<data-dir>/inbox.json`, hub-owned, atomic temp+rename, serialized by the single process.
- Message: `id`, `subject`, `body` (8 KB cap), `purpose` in `attention-needed` / `deliverable` / `extra-info` / `no-rush` (one validated list, easy to extend), `createdAt`, `readAt`, `archivedAt`, sender snapshot `{ logicalId, name, cwd, branch, piId }`.
- Sender identity: stable logical session id, resolved against live sessions and the index for current status (running/idle/stopped/archived/deleted).
- Retention: manual archive/delete only, no expiry. Default cap 200, `--inbox-limit` now, TOML key later (`open/60-options-toml-defaults.md`). Cap warnings are client-side.
- Transport: reachable wherever the UI is; no loopback gate (the daemon binds `100.42.42.1`).
- Auth seam shipped but off: `Authorization: Bearer` accepted when a token is configured; child env gets `PIXIP_INBOX_TOKEN` only then. The hub injects `PIXIP_DAEMON_URL` into every Pi child always.
- Non-goal: no sandboxing or message encryption; the file is plain JSON under the data dir.

### API

- `POST /api/inbox` `{ subject, body, purpose, sessionId? }`; anonymous local-shell send allowed, label `local shell`.
- `GET /api/inbox` (all, read, archived, purpose filters).
- `POST /api/inbox/:id/read`, `POST /api/inbox/read-all`, `POST /api/inbox/:id/archive`, `DELETE /api/inbox/:id`.
- Hub -> client `inbox` frame with unread count and newest message summary, broadcast on every change so the badge updates live.

### CLI

`pixip inbox send` (`--subject`, `--purpose`, `--quiet`), `pixip inbox list` (`--unread`, `--archived`, `--json`), `pixip inbox read <id|all>`, `pixip inbox archive <id>`, `pixip inbox delete <id>`. Use the existing `pixip.state.json` / `state.url` client pattern and `PIXIP_DAEMON_URL` when present, so it works with the VPN bind.

### Files

`src/inbox.ts` (new), `src/hub.ts`, `src/hubStore.ts` or a small `hubInbox.ts`, `src/server.ts`, `src/wire.ts`, `src/hubLive.ts` (child env), `bin/pixip.ts`, `src/daemon.ts` helpers if shared.

### Acceptance

- An agent running `pixip inbox send --subject X --purpose attention-needed "body"` from inside a session creates one message attributed to that logical session, visible via `GET /api/inbox` and the websocket count.
- Messages survive daemon restart and deletion of the sender session; the snapshot keeps name/cwd/branch.
- Archive hides from the default list and is restorable; delete is permanent; cap eviction never silently drops unread messages without a log line.
- Send works against the `100.42.42.1`-bound daemon from the same host.

### Tests

- `test/inbox.test.ts`: store round trip, atomic write, cap, archive/read, malformed file recovery.
- Hub/route tests: send/list/read/archive/delete, sender resolution live and deleted, unread count, token seam (on and off).
- CLI tests for send/list/read and daemon-down error.
- `npm run check` green.

### Grilling

Further grilling is welcome for exact error responses and cap-eviction ordering (prefer archived, then read, never unread). The decisions above are settled.

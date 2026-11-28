---
grilled: true
---

Add a read-only discovery surface so an agent can find other pixip sessions without opening the web UI. The same data is available through the new `agent_list` Pi tool and `pixip agents list`, and every returned agent includes a `#s=<id>` URL for its page.

### Goal

- Add `GET /api/agents` as the single contract used by the CLI and the extension. It returns active board sessions: current Pi id, stable logical id, name, state, cwd, repo, branch/worktree, `awaitingUser`, `lastActivity`, `isSelf`, and an absolute `url` of `http://<host>:<port>/#s=<routeId>`.
- Include live, attached, and stopped sessions. Archived/trash sessions are excluded by default and included only with an explicit opt-in flag, clearly marked.
- Add `extensions/pixip-agents` with an `agent_list` tool. Follow the `pixip-inbox` opt-in pattern, read `PIXIP_DAEMON_URL`, and never guess the daemon address. Do not register `agent_send` yet; that belongs to ticket 20.
- Add `pixip agents list [--json] [--all] [--cwd <path>] [--repo <path>] [--state <state>] [--query <text>]`. `--all` includes archived/trash.
- Keep order deterministic: the calling session first when `isSelf`, then repo/worktree grouping, then `lastActivity` newest first, then name/id.
- Use the current Pi session id for the URL route when available, falling back to the logical id. The same id must be accepted by ticket 20's send target.

### Done when

- Hub route, CLI command, and extension tool all return the same agent shape, including the URL.
- Discovery never creates, wakes, stops, archives, or deletes a session.
- Unknown or malformed filters fail with a readable error; an empty result is a normal success.
- Tests cover the hub route, URL construction, archived opt-in, self-marking, filters, the CLI, and the extension against a fake daemon.
- `npm run check` is green, including the workspace check for the new extension.

### Out of scope

- Sending messages (ticket 20), client rendering (ticket 30), session creation, and any UI mutation. Creation and other features stay in the web UI.
- Web authentication or restricted-mode gating.

### Grilling decisions

- `GET /api/agents` builds each `url` from the request `Host` header, falling back to the daemon URL. A daemon bound to `0.0.0.0` therefore still returns usable links for loopback/LAN/Tailscale callers.
- `--all` / `?all=1` includes both archived and trash sessions. Each returned row carries `stored: "archive"` or `stored: "trash"` plus the stored timestamp fields.
- `--cwd` and `--repo` match resolved absolute paths exactly (`~` and relative input resolved, no subtree matching). `--query` is a case-insensitive substring over name, id, logicalId, cwd, repo and branch.
- `--state` accepts the canonical states only: `starting`, `idle`, `busy`, `stopped`, `error`.
- The API success shape is `{"agents":[...],"count":N}`; CLI `--json` and the extension `details` use the same envelope and the same agent object shape.
- Self is passed as `?self=<logical-or-pi-id>` (the extension and CLI use `PIXIP_SESSION_ID` when inside a session); the hub marks matching rows `isSelf` and sorts them first.
- Each agent URL uses the current Pi session id (`id`) and falls back to `logicalId` only when the Pi id is unavailable.

### Result

- Added `src/agents.ts` (shape, filters, ordering, URL) and `GET /api/agents` in `src/server.ts`.
- Added `pixip agents list` to `bin/pixip.ts`, with `--json`, `--all`, `--cwd`, `--repo`, `--state` and `--query`.
- Added the opt-in `extensions/pixip-agents` workspace with the `agent_list` tool, README, configs and fake-daemon tests.
- Tests: hub route/URL/self/archive+trash/filters/order, CLI JSON+table+errors, extension query/self/errors/empty.
- Verified with `npm run check` (536 root tests, all workspace typecheck/lint/test runs green; browser check skipped because `PIXIP_CHROME` is unset and this ticket does not touch the client).

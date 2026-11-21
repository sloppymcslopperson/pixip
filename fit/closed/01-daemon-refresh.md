---
grilled: true
leg: tui-parity-1
commit: "91c2e62"
---

pixip can run as a managed background daemon and refresh itself: a soft reload of assets, command policy and the session index without touching live children, and a hard restart that survives via JSONL. This is what lets the agent edit pixip and pick up its own changes mid-session, and lets the user keep pixip up across shells.

### Why now

Dogfooding prep (slice 2 of the TUI-parity leg, right after `00-prefix-commands`). Once development moves into pixip, the hub must outlive the shell that started it, pick up code/config changes the agent makes, and not lose sessions when it restarts. Without this, every hub change means killing the process by hand mid-session.

### Done when

- `pixip start|stop|status|logs|refresh|restart` subcommands; bare `pixip` keeps serving in the foreground exactly as today. Pid, log and control state live under `<data-dir>` (`pixip.pid`, `pixip.log`), so `--data-dir` stays the isolation boundary and tests never touch a real daemon.
- `start` detaches (new session), writes the pid, refuses when one is already running for that data dir, validates port/data dir before detaching, and prints the URL; `stop` sends SIGTERM, waits, and cleans a stale pid; `status` reports pid/URL/uptime/session count and exits non-zero when not running; `logs` tails `<data-dir>/pixip.log`.
- Soft refresh (`pixip refresh`, `SIGHUP`, or `POST /api/refresh`): re-read client assets, `pixip.json` + per-project command policy, the session index and the command catalog; keep children and sockets; the response says what was reloaded.
- Hard refresh (`pixip restart [--force] [--when-idle]`): replaces the process. Sessions survive as JSONL and reattach on open; refuse while any session is busy unless `--force`; `--when-idle` waits (bounded, default ~5 min) for all sessions to be idle and exits non-zero on timeout. A short port gap is fine: the client already reconnects with backoff.
- UI: a small "reload" action (list and session header) calls the soft-refresh endpoint, then reloads the page and reconnects. No UI restart button.
- The refresh endpoint is loopback-only (the UI has no auth): non-loopback peers are rejected; the existing non-loopback bind warning stays.
- `/health` reports `startedAt` and a `reloads` counter so the client/agent can verify a refresh happened.
- `npm run check` green; tests for pid handling (stale pid, second start refused), soft refresh (asset cache dropped, policy re-read, live child survives), and the `--when-idle` decision with fakes; README gets a daemon section and ARCHITECTURE the startup/refresh path if it changes.

### Decisions (grilled 2026-11-21)

- Subcommands plus the current foreground default; no systemd/nix unit dependency in this slice (a unit example may be documented, but the CLI owns lifecycle).
- Soft refresh is the default: children and sockets are untouched, so a running turn is never disturbed. It re-reads the asset map, both `pixip.json` layers, the session index and the command catalog, and re-sends the per-session policy frame to live sockets.
- Hard restart is explicit: `--force` kills live children (the in-flight turn is lost, the JSONL remains); `--when-idle` is the agent's safe self-refresh path after changing hub code (wait for all sessions idle, then replace the process).
- Pid/log under the data dir rather than `/run` or `/var`, so parallel instances on other `--port`/`--data-dir` never collide.
- `status` exits non-zero when not running (scriptable); `refresh` exits non-zero if no daemon is running.
- Control endpoints stay loopback-only; no auth posture change.
- Refresh is idempotent and must not drop live sockets; repeated refreshes are safe.
- The soft-refresh endpoint returns `{reloaded: ["assets","config","index","commands"], reloads}`.

### Files

`bin/pixip.ts` (subcommands, pid/log, detach, signals), `src/server.ts` (refresh endpoint, loopback guard, `/health` fields, mutable asset map), `src/hub.ts` (reload hooks: index cache, policy cache, catalog; re-resolve policy for live sessions), `src/client/app.js`, `src/client/index.html`, `src/client/style.css` (reload action), `test/`, `README.md`, `ARCHITECTURE.md`.

### Tests

- CLI: start/status/stop on an ephemeral data dir + port; stale pid cleanup; second `start` refused; `status` non-zero when down.
- Soft refresh: with `--dev` off, change a client asset, refresh, assert the new bytes are served; change `pixip.json`, refresh, assert the new policy; assert a live fake-Pi child is still running.
- Hard restart: `--when-idle` with a busy fake session waits/exits non-zero; idle restart reattaches the same JSONL and the session list still shows it.
- Integration: `POST /api/refresh` from a loopback socket succeeds, and a request marked as non-loopback (or a bound non-loopback host) is rejected.
- Browser: reload action at 390/1280 is the owner's screenshot step.

### Notes

- `.pixip.json`/`pixip.json` policy is per session and is resolved at attach; soft refresh must re-resolve it for live sessions before claiming success.
- The daemon does not proxy or restart Pi children on soft refresh; that is the whole point of the split.
- Do not couple this to the transcript `resnapshot` frame from `05-builtin-commands`: that one re-requests a snapshot, this one reloads the hub's own caches.

### Remaining gaps (grilled 2026-11-21)

The `### Decisions` section above already covered scope, signals and the soft/hard
split. These are the gaps that were still open, now answered:

- **Restart owner: the CLI orchestrates.** `pixip restart` runs in the foreground:
  read the state file, SIGTERM the old daemon, wait for that pid to exit (and the
  port to free), spawn the new detached daemon with the same args, print the URL,
  exit. No daemon self-exec/re-exec trick; the daemon only reacts to SIGTERM and
  SIGHUP.
- **Catalog on soft refresh:** the command catalog is the static client asset
  `src/client/commands.js` (`00-prefix-commands`), so `commands` in `reloaded`
  reports that the asset re-read happened. No hub-side catalog, no new frame; the
  four-name contract (`assets`, `config`, `index`, `commands`) stays.
- **`logs` / `status` shape:** `logs` prints the last 200 lines, `-f`/`--follow`
  tails. `status` prints human text, `--json` prints pid/host/port/url/startedAt/
  uptime/session count for scripts. Both read the state file first, then `/health`
  or `/api/sessions` when the daemon answers.
- **`restart` with nothing running** starts a daemon and exits 0 (idempotent);
  `--when-idle`/`--force` are no-ops in that case.
- **Restart UX:** no new wire frame. The existing `reconnecting… (Nms)` toast and
  the durable cursor cover the port gap; `--when-idle` waits in the CLI process,
  so the old daemon keeps serving until it is actually idle.
- **Pid/state files:** `pixip.pid` stays a bare pid; a separate
  `<data-dir>/pixip.state.json` holds `{pid, host, port, url, startedAt, dataDir}`.
  Both live under the data dir, are written by `start` and removed on shutdown.
  Stale detection = missing/dead pid (or a pid that no longer matches the state
  file); `start`, `status` and `stop` clean stale files rather than fail.
- **`--when-idle` mechanics:** the CLI polls `GET /api/sessions` every 1 s; all
  sessions `idle`/`stopped`/`error` means proceed. Bounded by
  `--timeout <seconds>` (default 300). On timeout it names the still-busy sessions
  and exits 2; other failures exit 1.
- **Loopback guard scope:** `POST /api/refresh` only. `POST /api/sessions` and the
  stop route keep today's posture (the UI has no auth either way; this is not an
  auth change).
- **New modules are allowed** where they keep `bin/pixip.ts` thin: a
  `src/daemon.ts` for pid/state/detach/control helpers plus test helpers, and
  client changes stay in `app.js`/`index.html`/`style.css`.
- **Assumption:** soft refresh re-reads the session index *and* broadcasts a fresh
  `sessions` frame to list sockets, so the list is correct even before the page
  reload; the UI reload action still reloads the page afterwards.

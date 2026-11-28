# Daemon and CLI

pixip is one long-lived supervisor that owns a data directory, speaks HTTP and WebSocket to the browser, and spawns Pi-speaking children per session. This inventory covers how an operator starts, checks, reloads and replaces it, and how sessions and test data survive.

The CLI is the operator surface: `run` serves in the foreground, `daemon` detaches, and `stop`, `status`, `logs`, `refresh`, `reload` and `restart` manage the process. Everything it writes lives under `--data-dir`, also the test isolation boundary.

## Contents

- [User stories](#user-stories)
- [One process per data directory](#one-process-per-data-directory)
- [Starting in the foreground or as a daemon](#starting-in-the-foreground-or-as-a-daemon)
- [Status, logs and stop](#status-logs-and-stop)
- [Soft refresh](#soft-refresh)
- [In-place reload](#in-place-reload)
- [Restart and session survival](#restart-and-session-survival)
- [Restart when idle](#restart-when-idle)
- [Idle detach and reattach](#idle-detach-and-reattach)
- [Choosing the backend](#choosing-the-backend)
- [Bind address, auth posture and tokens](#bind-address-auth-posture-and-tokens)
- [The data-dir contract](#the-data-dir-contract)
- [Environment and startup configuration](#environment-and-startup-configuration)
- [Other CLI verbs](#other-cli-verbs)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As an operator, I want to start pixip, check it is alive, tail its log and replace it without losing sessions.
- As an operator, I want a restart that waits for idle work instead of interrupting an agent.
- As an operator, I want a scratch data directory for tests or a second instance.
- As an operator, I want to pick the embedded host or a system Pi binary, with a clear error if one is missing.
- As a security-conscious operator, I want a loopback default, a warning before binding wider, and to know the UI has no login.
- As an agent inside pixip, I want a self-update that does not stop the service under my turn.

## One process per data directory

A data directory has exactly one owner. `pixip run` refuses to start when a live daemon owns it, naming the pid; `pixip daemon` refuses for the same reason and when the host and port are in use. Two instances need their own `--data-dir`, usually `--port` too.

At startup the daemon writes `pixip.pid`, `pixip.state.json` (`{pid, host, port, url, startedAt, dataDir, args, env}`) and `pixip.log`. `args` and `env` reproduce the configuration — notably `PIXIP_PI_HOST` — so a restart starts the same daemon, not a default. The state records the actual bound port, making `--port 0` usable.

A pid whose process is gone is stale, not an error: `start`, `status` and `stop` clean it. A pid without state is treated alike.

## Starting in the foreground or as a daemon

Bare `pixip` and `pixip run` serve in the foreground. The process stays attached, writes the state file anyway (so `status`, `stop`, `refresh` and `reload` work), and exits on `SIGINT` or `SIGTERM` after closing sockets and children. Client edits are re-read per request, and `SIGHUP` soft-refreshes.

`pixip daemon` is the detached form. It checks for an existing daemon and a free port, creates `<data-dir>/sessions`, spawns `run` with stdio appended to `pixip.log`, detaches, then polls `/health` until the new pid answers. It prints the URL and pid on success, the log tail on failure, and never reports success just because the child spawned.

`--serious-mode` serves assets from the startup snapshot instead of reading them per request; dev mode is the default. `--watch` (off by default) watches `src/` and `extensions/`, debounces by 200 ms and runs the in-place reload below. A busy session is never interrupted: the watcher polls the reload gate, logs the deferral, and after about a minute shows a card with `Keep waiting` and `I'll reissue later`. A failed reload is logged and shown as a notice while the daemon keeps serving. The CLI owns the watcher, so tests never start one.

## Status, logs and stop

`pixip status` reads the state file, then `/health` and `/api/sessions`, and prints URL, pid, uptime, session count, reloads and data directory; `--json` returns the same facts. Down, it prints `pixip is not running for <data-dir>` and exits non-zero, so it works as a service check.

`pixip logs` prints the last 200 lines of `pixip.log`, adjustable with `--lines`. `-f`/`--follow` polls every 300 ms until `SIGINT`; a missing log is an error naming the path.

`pixip stop` sends `SIGTERM`, waits for exit, escalates to `SIGKILL` after 10 seconds and clears pid/state. It prints the stopped pid or says the daemon was not running. From inside a pixip session it refuses with exit 2: an agent's bash tool must not take the service down; a shell outside pixip still stops for real.

## Soft refresh

`pixip refresh` POSTs `/api/refresh` and prints what was reloaded. The daemon re-resolves command policy for every live session in two phases (a malformed config fails before anything swaps), re-reads `sessions.json`, drops the header cache, swaps the asset map, and pushes fresh policy and sessions frames. Live children and WebSockets are untouched, so a turn in progress never notices.

`SIGHUP` does the same, so a service manager can nudge it. `/health` reports `startedAt`, a `reloads` counter and the generation. The endpoint is loopback-only (plus the exact bind address), because the UI has no authentication.

## In-place reload

`pixip reload` swaps assets, policy, session index and the daemon's own code without replacing the process. It is user-only inside an agent (exit 2). The CLI signals `SIGUSR1` and polls `<data-dir>/pixip.reload.json`; exit 1 means refused or failed, and success prints the report. The browser's `/reload` and `--watch` reuse it.

The gate refuses while any live session is not `idle`/`stopped`/`error`, has a pending UI request, is running bash, or has an unsettled turn. A refusal names every blocker and changes nothing; `/reload` never forces. The browser may offer a pause/resume opt-in; the CLI reports the refusal.

A successful reload imports the next code generation first and fails closed, then swaps the hub prototype and server implementation. The listener, sockets and live children stay up. It re-reads assets and policy, rotates the browser nonce, sends `reload` to every host child and respawns system-pi children through the current host configuration. Child failures are per session and do not roll back code or assets. Changes to `bin/pixip.ts`, serve flags, `HubOptions` or the environment require a restart rather than being half-applied.

## Restart and session survival

`pixip restart` replaces the process. The CLI records the logical ids that were live (idle, busy or starting) into `<data-dir>/pixip.resume.json`, spawns a detached helper and waits up to 30 seconds for a new pid with healthy `/health`. If the helper never brings the daemon back, the CLI points at the log.

The helper survives the caller. It reads the old state, sends `SIGUSR2` (the old process announces `{"t":"restarting"}` and flushes it), waits for exit, then starts the same serve args and environment. The new daemon consumes the resume set after listening and reattaches each logical session. The dashboard's grouping looks unchanged, and the JSONL is the durable truth: a busy turn is interrupted, but history, name and index record survive. The browser reconnects with its durable cursor and reports `daemon restarted (pid, uptime)`.

Restart is idempotent when nothing runs: it starts the daemon. It refuses while any session is busy unless `--force`, naming the blockers; `--force` interrupts them. Unexpected crashes have no restart frame, so the client applies the same socket-close reconnect without claiming a planned restart. The stop/start runs in the helper, not the CLI, because the CLI may be a child of the Pi child the restart kills; the helper strips the caller's session identity so later children do not inherit it.

## Restart when idle

`pixip restart --when-idle` polls the session list once a second until every session other than the caller is idle, stopped or errored. The caller does not count: its turn is about to end. The wait is bounded by `--timeout` (default 300 seconds); on timeout it prints the busy sessions and exits 2. The browser's `/pixup-restart` is the same idea with a refusal card, a forced restart and an optional pause/resume flow. Its plan is persisted in `<data-dir>/pixip.pause.json`; the replacing daemon sends `Reload is finished, please resume.` only to live, idle or stopped targets.

## Idle detach and reattach

A session idle for `--idle-ms` (default 15 minutes, `0` disables) has its Pi child detached. It is not deleted: its JSONL, index record and name remain, and the dashboard lists it as `stopped`. Opening it attaches a fresh child from that JSONL, as does a stopped or restarted session. A stopped transcript is read from the JSONL tail, so it opens without a child. This is the memory story — dozens of named sessions, few children — at the cost of a cold attach; `--idle-ms` is a serve flag and part of the recorded configuration.

## Choosing the backend

The default is the embedded `pixip-pi-host` package. `PIXIP_PI_HOST` overrides the executable; the path must exist, and a missing package or bin fails with an install hint, never a global `pi` fallback.

The legacy backend is the explicit `--use-system-pi` opt-in and requires `--pi` or `PIXIP_PI`. Either without `--use-system-pi` is an error, and `--use-system-pi` with neither is an error, so the choice is deliberate. An explicit flag wins over the environment unless the flag is the literal default `pi`. The system path logs that host-only capabilities such as the panel are unavailable. `PIXIP_PI_HOST` is recorded in the state file so a restart reproduces the host choice.

Both backends speak the same Pi RPC; hub state, wire frames and browser protocol do not change with the choice. Reload keeps it: host children answer `reload`, system-pi children are respawned through the current host configuration.

## Bind address, auth posture and tokens

The default bind is `127.0.0.1`. `--host` accepts any address, but anything other than loopback prints a warning: the browser UI has no authentication. That is a constraint of the current surface, not a feature to preserve blindly; binding wider exposes the session API to anyone who can reach the port.

`POST /api/refresh` only accepts local peers (and the exact bind address) because it mutates server state. The inbox API has an optional bearer token, `--inbox-token` or `PIXIP_INBOX_TOKEN`, off by default and passed to Pi children. It does not authenticate the session or WebSocket surface. Startup must not assume a public vhost or an unauthenticated `0.0.0.0` default.

## The data-dir contract

`--data-dir` (default `./tmp/dev`, env `PIXIP_DATA_DIR`) owns everything persisted: `pixip.pid`, `pixip.state.json`, `pixip.log`; `pixip.reload.json`, `pixip.resume.json` and `pixip.pause.json`; `sessions/` (Pi's `--session-dir`, the only place JSONL lives); `sessions.json` (pixip's index); `inbox.json`, `reports/`, `uploads/`, `pending-ui/`, `exports/`, `archive/` and `trash/`; and `pixip.json`, the per-data-dir command policy.

Pi is always spawned with `--session-dir <data-dir>/sessions`. Tests never read or write `~/.pi/agent/sessions`, and a scratch directory is a complete sandbox: delete it and no user session is affected. A second instance can run beside the first, and session files are never shared between two live processes.

Command policy is restrict-only: `<data-dir>/pixip.json` plus `<cwd>/.pixip.json`, narrowed by `--allow-command`, `--deny-command` and `--no-bash`, with deny winning. Soft refresh and reload re-resolve it.

## Environment and startup configuration

Serve flags that change behaviour are `--host`, `--port`, `--data-dir`, `--use-system-pi`, `--pi`, `--idle-ms`, the three `--pending-ui-*` timeouts (`--pending-ui-timeout-ms`, `--pending-ui-open-timeout-ms`, `--pending-ui-more-time-ms`), `--title-model`, `--serious-mode`, `--watch`, `--inbox-limit`, `--inbox-token`, `--allow-command`, `--deny-command` and `--no-bash`. The pending-UI timeouts are 5 hours with no browser, 10 hours with one, and 2 minutes for a `more time?` card; `0` disables each. `--title-model`/`PIXIP_TITLE_MODEL` selects the model for automatic names.

Startup environment: `PIXIP_DATA_DIR`, `PIXIP_PI_HOST`, `PIXIP_PI` (system mode only), `PIXIP_TITLE_MODEL` and `PIXIP_INBOX_TOKEN`. Every Pi child receives `PIXIP_SESSION_ID`, `PIXIP_INSIDE=1`, `PIXIP_DAEMON_URL` and, when set, `PIXIP_INBOX_TOKEN`. Child spawning strips `PI_SESSION_ID`/`PI_SESSION_FILE` (they describe whichever Pi session started the daemon) and repairs `XDG_RUNTIME_DIR` to a user-owned directory (falling back to `~/.run`) without mutating the daemon's environment. Provider auth, Pi config, `PATH` and proxy variables pass through.

## Other CLI verbs

`pixip worktree list|remove|prune` inspects and removes worktrees, using the daemon when one owns the data directory and reading offline otherwise. `pixip ref <tag>` resolves a copied `[pixip-ref=…]` tag without a daemon. `pixip inbox send|list|read|archive|delete` talks to `PIXIP_DAEMON_URL` when set, otherwise to the daemon for `--data-dir`. `pixip protect [<session-id>] [--off] [--json]` excludes a session from bulk archive and defaults to the caller's `PIXIP_SESSION_ID`. See [worktrees](70-worktrees.md), [refs](75-refs.md), [inbox and reports](60-inbox-reports.md) and [session control](80-session-control.md).

## Wireframes

### Operator terminal flow

```svg
<svg viewBox="0 0 720 480" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf85-terminal">
  <title id="wf85-terminal">Terminal screens for run, daemon, status, logs and restart</title>
  <rect x="4" y="4" width="346" height="472" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">FOREGROUND</text>
  <text x="18" y="50" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip run --data-dir ./tmp/dev</text>
  <text x="18" y="68" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">pixip listening on http://127.0.0.1:8137/</text>
  <text x="18" y="84" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">pid 4211, data dir ./tmp/dev, log .../pixip.log</text>
  <text x="18" y="100" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">dev mode: client assets re-read per request</text>
  <text x="18" y="124" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">state file written now, so status/stop work</text>
  <text x="18" y="138" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">SIGHUP soft refresh · Ctrl-C shutdown ·</text>
  <text x="18" y="152" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">second start refuses while this owns the dir</text>
  <line x1="18" y1="170" x2="336" y2="170" stroke="#322b45"/>
  <text x="18" y="192" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">DETACHED</text>
  <text x="18" y="216" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip daemon --data-dir ./tmp/dev</text>
  <text x="18" y="234" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">pixip listening on http://127.0.0.1:8137/ (pid 4302)</text>
  <text x="18" y="250" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">detach → run, stdio → pixip.log, poll /health</text>
  <text x="18" y="264" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">port/dir collision → error, not a second daemon</text>
  <line x1="18" y1="282" x2="336" y2="282" stroke="#322b45"/>
  <text x="18" y="304" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">CHECK</text>
  <text x="18" y="328" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip status</text>
  <text x="18" y="346" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">pixip running on … (pid 4302, up 2h14m, 5 session(s), 3 reload(s))</text>
  <text x="18" y="362" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">data dir: /…/tmp/dev</text>
  <text x="18" y="380" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">down → exit 1 · --json for scripts</text>
  <text x="18" y="400" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip logs -f --lines 50</text>
  <text x="18" y="416" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">tails …/pixip.log · Ctrl-C stops following</text>
  <line x1="18" y1="430" x2="336" y2="430" stroke="#322b45"/>
  <text x="18" y="446" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the phone dashboard is a client of this daemon,</text>
  <text x="18" y="460" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">not a terminal mirror: HTTP + WebSocket, no auth.</text>

  <rect x="366" y="4" width="350" height="472" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="380" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">REFRESH / RELOAD</text>
  <text x="380" y="50" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip refresh</text>
  <text x="380" y="68" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">reloaded assets, config, index, commands (4 total)</text>
  <text x="380" y="84" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">soft: children and sockets stay up</text>
  <text x="380" y="104" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip reload</text>
  <text x="380" y="122" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">reload: assets, policy and daemon code (gen 4)</text>
  <text x="380" y="138" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">busy session → refusal naming blockers, exit 1</text>
  <text x="380" y="152" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">inside an agent → user-only, exit 2</text>
  <line x1="380" y1="170" x2="702" y2="170" stroke="#322b45"/>
  <text x="380" y="192" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">RESTART</text>
  <text x="380" y="216" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip restart --when-idle</text>
  <text x="380" y="234" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">poll sessions → wait for non-callers to settle</text>
  <text x="380" y="248" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">timeout (300s) → name busy sessions, exit 2</text>
  <text x="380" y="262" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">idle → record live set → spawn helper</text>
  <text x="380" y="278" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">pixip restarted on http://127.0.0.1:8137/ (pid 4410)</text>
  <text x="380" y="300" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">helper: SIGUSR2 old → stop → start same args</text>
  <text x="380" y="314" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">new daemon reattaches resumed logical ids</text>
  <line x1="380" y1="332" x2="702" y2="332" stroke="#322b45"/>
  <text x="380" y="354" font-family="ui-monospace, monospace" font-size="10" fill="#7aa2f7">$ pixip stop</text>
  <text x="380" y="372" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">stopped pixip (pid 4410)</text>
  <text x="380" y="388" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">SIGTERM → 10s → SIGKILL, then clear pid/state</text>
  <text x="380" y="404" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">inside a session → refused, exit 2</text>
  <text x="380" y="418" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">browser: /pixup-restart is the user control</text>
</svg>
```

### Decisions: start, restart, backend, bind

```svg
<svg viewBox="0 0 720 380" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf85-flow">
  <title id="wf85-flow">Decision flow for start mode, restart condition, backend and bind address</title>
  <rect x="4" y="4" width="346" height="372" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">START AND RESTART</text>
  <rect x="18" y="38" width="140" height="26" rx="5" fill="none" stroke="#7aa2f7"/>
  <text x="26" y="55" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">pixip start?</text>
  <text x="174" y="52" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">data dir already owned → refuse</text>
  <text x="174" y="64" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">port in use → refuse</text>
  <line x1="88" y1="64" x2="88" y2="86" stroke="#6f6889"/>
  <text x="18" y="100" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">terminal?</text>
  <rect x="18" y="108" width="128" height="24" rx="5" fill="none" stroke="#7aa2f7"/>
  <text x="26" y="124" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">run (foreground)</text>
  <text x="160" y="124" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">· no → daemon (detached + health poll)</text>
  <line x1="88" y1="132" x2="88" y2="154" stroke="#6f6889"/>
  <rect x="18" y="156" width="156" height="26" rx="5" fill="none" stroke="#bb9af7"/>
  <text x="26" y="173" font-family="ui-monospace, monospace" font-size="9" fill="#bb9af7">restart?</text>
  <text x="188" y="166" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">not running → just start</text>
  <text x="188" y="180" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">busy → refuse (exit 1)</text>
  <text x="18" y="202" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">--force: interrupt blocker</text>
  <text x="18" y="216" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">--when-idle: wait, caller excluded</text>
  <text x="18" y="230" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">timeout → exit 2, nothing replaced</text>
  <line x1="18" y1="246" x2="336" y2="246" stroke="#322b45"/>
  <text x="18" y="268" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">survives: JSONL, index, names, archive</text>
  <text x="18" y="284" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">reattaches: live set recorded before helper</text>
  <text x="18" y="300" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">lost: in-memory state, bus turns, panels</text>
  <text x="18" y="314" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">prompts still on disk replay from JSONL</text>
  <text x="18" y="336" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">browser reconnects with durable cursor</text>
  <text x="18" y="350" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">and paints one restart row</text>

  <rect x="366" y="4" width="350" height="372" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="380" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">BACKEND AND BIND</text>
  <text x="380" y="48" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">--use-system-pi?</text>
  <line x1="380" y1="58" x2="380" y2="76" stroke="#6f6889"/>
  <text x="388" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">no → resolve pixip-pi-host</text>
  <text x="400" y="88" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">PIXIP_PI_HOST override, must exist</text>
  <text x="400" y="102" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">missing → fail with install hint</text>
  <line x1="380" y1="112" x2="380" y2="130" stroke="#6f6889"/>
  <text x="388" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">yes → require --pi or PIXIP_PI</text>
  <text x="400" y="142" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">neither → fail, no silent fallback</text>
  <text x="400" y="156" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">flag wins over env; logs no-panel warning</text>
  <line x1="380" y1="172" x2="380" y2="190" stroke="#322b45"/>
  <text x="380" y="208" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">--host?</text>
  <text x="380" y="226" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">unset → 127.0.0.1 (loopback default)</text>
  <text x="380" y="240" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">loopback/::1 → no warning</text>
  <text x="380" y="254" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">anything else → warning: no auth</text>
  <text x="380" y="268" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">refresh endpoint stays local-only</text>
  <text x="380" y="282" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">inbox token optional, off by default</text>
  <line x1="380" y1="298" x2="702" y2="298" stroke="#322b45"/>
  <text x="380" y="318" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">--data-dir is the isolation boundary</text>
  <text x="380" y="334" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">pid · state · log · sessions · sessions.json</text>
  <text x="380" y="348" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">inbox · reports · uploads · pending-ui · archive</text>
  <text x="380" y="362" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Pi gets --session-dir &lt;data-dir&gt;/sessions</text>
</svg>
```

## Port-relevant technical notes

### Supervision files and signals

`src/daemon.ts` owns pid/state/log paths, detached start, health polling, soft refresh, the busy/restart decision and the resume set. State is atomic (temp plus rename) and records the actual port, serve args and extra environment. `runningDaemon` removes a dead pid or a pid without state; `stopDaemon` signals, polls `pidAlive`, escalates to `SIGKILL` and clears state. `SIGINT`/`SIGTERM` close watch, server and hub; `SIGHUP` soft-refreshes; `SIGUSR1` reloads; `SIGUSR2` announces the restart and shuts down for the helper.

### The restart transaction

`pixip restart` computes `liveSessionIds` from `/api/sessions` (idle, busy or starting; `logicalId` falling back to `id`), writes `pixip.resume.json`, and spawns `restart --detached` with `spawnEnv()` minus `PIXIP_SESSION_ID`. The helper reads the old state for args and environment, sends `SIGUSR2`, waits for exit, then calls `startDaemon`. The new daemon calls `takeResumeSet` (read and unlink, so one replacement consumes it) and reattaches each id. `pixip.pause.json` is the analogous hand-off for browser pause/resume, consumed by `resumePaused`. `/reload` imports a fresh `?gen=N` graph behind the `src/reload/register.ts` resolve hook, swaps the hub prototype and `state.impl`, and leaves the listener and children up. Only `src/` is reloadable; the entry point, flags, options and environment report `requiresRestart`.

### Idle detach, stopped sessions and reattach

`scheduleIdle` sets an unref'd timer per session; expiry calls `stop`, which clears timers, removes the live entry, sets `stopped`, persists the name, closes the child and refreshes peers. The JSONL and index record remain; `window` and the listing read disk for a non-live id, and attach spawns a child from the same file. The surviving identity is the logical id plus its `piIds`.

### Backend and env seam

`src/backend.ts` is the single spawn seam: `piRpcBackend.create` returns the RPC child, and the hub picks host versus system-pi by configuration. `resolvePiHost` validates `PIXIP_PI_HOST` or resolves the package bin and fails rather than falling back. `src/spawnEnv.ts` drops `PI_SESSION_ID`/`PI_SESSION_FILE`, repairs `XDG_RUNTIME_DIR` without touching `process.env`, and lets explicit per-child values win. The hub adds `PIXIP_SESSION_ID`, `PIXIP_INSIDE` and `PIXIP_DAEMON_URL`.

### Data-dir, port and auth boundary

`--data-dir` is passed as `--session-dir <data-dir>/sessions` to Pi, and every persistent file joins the same root. The daemon binds `--host`/`--port`, defaults to `127.0.0.1:8137`, warns on non-loopback, and exposes `/health` and the session API without authentication; `POST /api/refresh` rejects non-local peers. The contract is supervision, one owner per data dir, JSONL truth and the loopback default.

## Boundaries

Dashboard discovery, grouping, stop/wake, archive and trash belong to [dashboard and sessions](10-dashboard-sessions.md); per-session model, naming and fork/clone to [session control](80-session-control.md); worktree commands to [worktrees](70-worktrees.md); ref resolution to [refs](75-refs.md); inbox storage to [inbox and reports](60-inbox-reports.md); extension dialogs to [extension UI](40-extension-ui.md). This area owns the supervisor, lifecycle verbs, data-dir contract, backend selection and bind/auth posture.

## Sources

`bin/pixip.ts`, `src/daemon.ts`, `src/reload/manager.ts`, `src/reload/pause.ts`, `src/reload/register.ts`, `src/reload/watch.ts`, `src/spawnEnv.ts`, `src/backend.ts`, `src/hubLive.ts` (idle/stop/reattach), `src/hubControl.ts` (reload gate, restart blockers, stopped-session window), `src/server.ts` (`/health`, `/api/refresh`), `src/dirs.ts`, `test/daemon.test.ts`, `test/reload.test.ts`, `README.md` (running as a daemon, backends), and `ARCHITECTURE.md` (reload and restart, backend and port boundary, isolation, environment seam).

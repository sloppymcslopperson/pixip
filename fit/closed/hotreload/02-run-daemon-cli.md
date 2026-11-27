---
project: pixip
grilled: true
---

Rename the two ambiguous daemon subcommands to `run` (foreground) and `daemon` (detached), and make the dogfood values the defaults: `--dev` on, the `XDG_RUNTIME_DIR` fallback in the daemon, and no code-level bind address. One CLI-surface ticket so `bin/pixip.ts` is touched once before the pi-host default lands.

### Rename

- `pixip run` replaces the implicit `serve` fallback and becomes a real subcommand; today `pixip serve` fails with `unknown argument serve` because `serve` is only the fallback in `main()` (`bin/pixip.ts:477`).
- `pixip daemon` replaces `start` (detached, stdio to `<data-dir>/pixip.log`, polls `/health`, prints the URL).
- No subcommand stays foreground, so `npm start` is unchanged.
- `stop`/`status`/`logs`/`refresh`/`restart` keep their names.
- `src/daemon.ts:249` spawns `[daemonEntry(), "run", ...args]` explicitly instead of relying on the default command.
- `serveArgs()` stays flags-only; the state file and `restart` are unaffected.
- No compatibility aliases: the only consumers are in-repo (README, tests, the ignored `dev.sh`).

### Defaults

- `--dev` defaults to true (per-request asset read, `src/server.ts:563`, plus the panel fixture); add `--prod` to opt out. Log `dev mode: client assets re-read per request` at startup so it is never a surprise.
- Port 8137, idle 900000, the three pending-UI timeouts and inbox-limit 200 are already the defaults; nothing to change.
- Keep `--data-dir` at `./tmp/dev` and leave the value in `dev.sh`; `tmp/trial` is a dogfood location, not an app default.
- Keep `--host` a flag with the loopback default. The tailnet address lives only in the ignored `dev.sh`, never in code, help text, or the state defaults.

### Runtime dir

- Move the `XDG_RUNTIME_DIR` fallback out of `dev.sh` into the daemon: if unset or not owned by the current uid, create `~/.run` with 0700 and export it before any child spawn (`src/spawnEnv.ts`).
- It must apply in both `run` and the detached `daemon` path, otherwise `restart` loses it.

### Ripple

- `test/daemon.test.ts:38,97` and `test/worktree-cli.test.ts:61` (`start` → `daemon`), plus an explicit `run` case.
- Rename the test helper `run(...)` to `cli(...)` while touching those call sites, so `run(["run", …])` never appears.
- `README.md:167,184` and the prose in `ARCHITECTURE.md:461`.
- `dev.sh` (gitignored, never committed) becomes `pixip daemon --host 100.42.42.1 --data-dir ./tmp/trial`.

### Acceptance

- `pixip run` serves in the foreground; `pixip daemon` detaches and writes state; bare `pixip` behaves as `run`.
- `pixip serve` and `pixip start` are rejected as unknown commands.
- `--prod` disables the per-request asset read and the fixture endpoint.
- `pixip daemon` from a shell without `XDG_RUNTIME_DIR` runs the browser tool without a permission error, and `restart` keeps that property.
- `npm run check` green (after `00-test-harness-pixip-env` this is true from inside a session too).

### Notes

- Do not commit `dev.sh`; it is gitignored by policy.
- `03-pi-host-by-default` builds on this ticket's `parseArgs`/help changes.

### Grilling answers (recorded 2026-11-21, incomplete)

Answers so far, recorded for the batch. This ticket was pulled forward by mistake; it was reverted to open and is **not** grilled yet.

- `dev.sh` is not in this worktree; the live copy is `/home/sloppy/dev/sin/pixip/dev.sh` in master. Edit that copy (untracked) rather than creating one here.
- Runtime dir: if `~/.run` exists with the wrong owner, throw a clear error; if we own it but the mode is wrong, repair it to 0700. Never silently use a foreign dir.
- `spawnEnv()` is return-only: the repaired `XDG_RUNTIME_DIR` goes into the returned env, not into `process.env`.
- Dev opt-out flag: `--serious-mode` (not `--prod`). Intent is "hosting pixip as a service, keep it stable", not a security lockdown; more behaviours can attach to it later. `--dev` stays accepted.
- Unknown top-level tokens error as `unknown command <name>`; unknown flags keep `unknown argument <flag>`.
- Foreground `run` test: in `test/daemon.test.ts`, spawn the CLI, wait for the listening line/health, assert the state file, then SIGTERM.
- Scope also includes the stale `--dev` notes in `AGENTS.md` and `README.md`.

Still open: `--dev`/`--serious-mode` precedence (last flag wins vs serious always wins), whether saved daemon state args record the explicit flag, and the level of the fixture-off test (integration vs server unit). Do not implement until the batch grilling round finishes.

### Grilling answers (closed 2026-11-25)

- `--dev` is removed from parseArgs and help; dev mode is the default and `pixip run --dev` now errors as `unknown argument --dev`. `--serious-mode` is the only mode flag.
- Saved daemon state records the explicit `--serious-mode` when the user passed it, so `restart` reproduces the requested mode; no flag means rely on the default.
- `--serious-mode` coverage is a server unit test: construct the server in serious mode, assert no per-request asset re-read and the fixture endpoint disabled. No daemon integration test for this.
- The live `dev.sh` at `/home/sloppy/dev/sin/pixip/dev.sh` is edited there and not committed here; README/AGENTS prose is updated in this worktree.
- The earlier `--dev`/`--serious-mode` precedence question is moot now that `--dev` is gone.

### Implementation (2026-11-25)

- Commands are now `run` (foreground; also the bare default) and `daemon` (detached). `start`/`serve` fail with `unknown command <name>`; `--dev` fails with `unknown argument --dev`.
- `src/daemon.ts` spawns `[daemonEntry(), "run", ...args]`.
- Dev mode is the default; `--serious-mode` opts out, is recorded in the daemon state args, and logs `serious mode: client assets served from the startup snapshot`. The default logs `dev mode: client assets re-read per request`.
- `spawnEnv()` repairs `XDG_RUNTIME_DIR` in its returned env (never `process.env`): an owned value is kept, otherwise `~/.run` is created/kept at 0700; a wrong-owner `~/.run` throws and a non-directory path is refused. A mode repair is applied when we own it.
- `/home/sloppy/dev/sin/pixip/dev.sh` now just execs `daemon --host 100.42.42.1 --port 8137 --data-dir ./tmp/trial` (no XDG block, no `--dev`); not committed here.
- Tests: `cli()` helper in both CLI test files, `daemon` command, explicit foreground `run` + SIGTERM, retired-command/`--dev` errors, serious-mode state/log, server serious-mode asset/fixture unit test, and `spawnEnv` runtime-dir cases. README/ARCHITECTURE/AGENTS prose updated.
- Verified: `npm run check` green (432 tests); daemon and restart both inherit `XDG_RUNTIME_DIR=/home/sloppy/.run` when launched with it unset.
- Operational note: a daemon already running from before this change has `--dev` in its saved state args; stop/start it once rather than `restart`, which would now reject that flag.

---
project: pixip
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

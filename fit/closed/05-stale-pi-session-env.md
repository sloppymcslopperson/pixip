---
project: pixip
grilled: true
---

Hub-spawned Pi children inherit the daemon's stale `PI_SESSION_FILE`/`PI_SESSION_ID` from whichever Pi session restarted the daemon. Strip session-scoped `PI_*` identity at the spawn seams so each child sees only its own session.

### Symptoms

Observed on the live `tmp/trial` daemon (pid 305844):

- The daemon env carried `PI_SESSION_FILE=…/sessions/2026-11-24T02-08-45-536Z_01a20b50-….jsonl` and `PI_SESSION_ID=01a20b50-…` because it was restarted from inside that Pi session.
- The worktree child (pid 305931) had `PIXIP_SESSION_ID=0a505912…` but `PI_SESSION_FILE` still pointed at `01a20b50…`.
- The main-repo child (pid 305863) had `PIXIP_SESSION_ID=6bcdf785…` but `PI_SESSION_FILE` still pointed at `01a20b50…`.

### Root cause

- `bin/pixip.ts` `spawnRestartHelper()` deletes only `PIXIP_SESSION_ID`; the restarted daemon keeps the caller's `PI_SESSION_FILE`/`PI_SESSION_ID`.
- `src/rpc.ts` spawns children with `env: { ...process.env, ...options.env }`, so every hub child inherits those stale Pi session vars even though `PIXIP_SESSION_ID` is per session.

### Scope

- Strip Pi session identity (`PI_SESSION_FILE`, `PI_SESSION_ID`, and any other session-scoped `PI_*` vars the harness relies on) when launching the restart helper and when spawning hub children; keep `PIXIP_SESSION_ID` as the per-session key.
- Cover both the legacy `pi` child and the `pixip-pi-host` child, and any other hub-spawned helper that runs Pi.
- Leave unrelated user environment (provider auth, PATH, proxy vars) untouched.

### Acceptance

- A daemon restarted from inside a Pi session spawns children whose `PI_SESSION_ID`/`PI_SESSION_FILE` match the child's real session, not the caller's.
- Starting a fresh session in a worktree yields a child env with no `PI_*` identity from any other session.
- Existing create/attach/restart flows keep working.

### Tests

- Unit test asserting the spawn env removes/overrides stale `PI_SESSION_FILE` and `PI_SESSION_ID`.
- Hub test with a fake backend that records its env; assert the values match the spawned session.
- `npm run check` green.

### Constraints

- Do not change the wire protocol or client assets.
- Keep the Rust-port boundary: env sanitising belongs at the spawn seam, not in extensions.
- Do not touch the model-provider latency issue; that is upstream `opencode-go` and is out of scope here.
- The archived-process / logical-id reuse bug is a separate ticket (`06-archive-session-identity`), not this one.

### Grilled decisions (2026-11-24)

- **Vars:** strip only `PI_SESSION_ID` and `PI_SESSION_FILE` (strict ticket wording). Leave `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, the `AI_AGENT`/`PI_CODING_AGENT` markers, Pi config vars (`PI_CODING_AGENT_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, …), auth, PATH, and proxy vars alone. Pi injects its own correct session values into its bash tools; the seam only guarantees no inherited stale value.
- **Seams:** all four — `RpcChild` (`src/rpc.ts`, covers legacy `pi` and `pixip-pi-host`), the title `execFile` child (`src/hubSession.ts`), `spawnRestartHelper` (`bin/pixip.ts`), and `startDaemon` (`src/daemon.ts`).
- **Design:** a new shared pure helper `src/spawnEnv.ts`: `spawnEnv(extra?, base = process.env)` copies the base, deletes the two session keys, then merges `extra` last. Unit tests pass a fake `base`.
- **Precedence:** inherited process env is cleaned; an explicit `extra` value (hub `options.env`, tests) wins.
- **Existing behaviour kept:** hub children still get `PIXIP_SESSION_ID`/`PIXIP_INSIDE`; the restart helper still deletes `PIXIP_SESSION_ID` because it is not a session.
- **Tests:** unit test for the helper; hub/backend test capturing the spawned env; one daemon restart test injecting stale `PI_SESSION_*` and asserting the child env is clean (`fake-pi` logs it).
- **Docs:** short ARCHITECTURE.md note at the spawn/Rust-port boundary.
- **Scope:** one ticket, no split.

### Result

- Added `src/spawnEnv.ts` (`spawnEnv(extra?, base = process.env)`): drops `PI_SESSION_ID`/`PI_SESSION_FILE`, then applies explicit extras last.
- Wired it into all four seams: `RpcChild` (`src/rpc.ts`), title `execFile` (`src/hubSession.ts`), `spawnRestartHelper` (`bin/pixip.ts`, which still drops `PIXIP_SESSION_ID`), and `startDaemon` (`src/daemon.ts`).
- Tests: `test/spawn-env.test.ts` (pure helper, fake base), a second `test/backend.test.ts` case asserting `PIXIP_SESSION_ID`/`PIXIP_INSIDE` and no inherited `PI_SESSION_*`, and a `test/daemon.test.ts` restart test that injects stale `PI_SESSION_*`, then asserts the `fake-pi` child logs `piSessionId: null`, `piSessionFile: null`, and the child's own `pixipSessionId`. `fake-pi.mjs` now logs both.
- `ARCHITECTURE.md`: short note on the spawn-seam rule next to the embedded-host boundary.
- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` green (typecheck, lint, format, imports, node tests, browser check, both workspaces).
- Note for review: Pi injects `PI_SESSION_ID`/`PI_SESSION_FILE` into its own bash tools at command time, so the acceptance is met by removing the inherited values; the child's Pi then supplies its real session values.
- Observation (not fixed here): running `npm run check` from inside a pixip-managed Pi session leaks `PIXIP_INSIDE`/`PIXIP_SESSION_ID` into `test/daemon.test.ts`, turning test `stop` calls into restarts. Pre-existing; a follow-up ticket can scrub those in the test harness if wanted.

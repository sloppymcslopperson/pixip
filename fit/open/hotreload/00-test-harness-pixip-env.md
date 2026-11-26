---
project: pixip
---

Running `npm run check` from inside a pixip-managed Pi session leaks `PIXIP_INSIDE` and `PIXIP_SESSION_ID` into the test processes, so `test/daemon.test.ts` treats its own `stop` calls as inside-session restarts and two lifecycle tests fail. Scrub those markers in the test harness so the suite is green regardless of where it is launched from.

### Problem

Found while closing `05-stale-pi-session-env` (2026-11-24). In a Pi child of a pixip daemon, `env` carries `PIXIP_INSIDE=1` and `PIXIP_SESSION_ID=<logical id>`. `bin/pixip.ts` `insidePixip()` reads both, so the CLI spawned by tests for `pixip stop --data-dir …` prints `pixip restarted …` instead of stopping. Failing cases observed: `test/daemon.test.ts` "starts, reports, refreshes, tails and stops one data dir" and "turns stop from inside a pixip session into a restart".

Running `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` is green, which confirms the cause.

### Scope

- Make the test suite independent of the launcher's `PIXIP_INSIDE`/`PIXIP_SESSION_ID`.
- Prefer clearing them once where tests spawn the CLI/daemon (e.g. `test/helpers/harness.ts` and the `run`/`start` helpers in `test/daemon.test.ts`), instead of per-test opt-outs.
- Do not change `insidePixip()` semantics: a real inside-session `stop` must still restart.
- Do not regress the explicit `PIXIP_SESSION_ID` cases that test restart-on-busy (they set it deliberately and must keep working).

### Acceptance

- `npm run check` passes when launched from inside a pixip-managed Pi session (both markers set) and outside one.
- A test that deliberately sets `PIXIP_SESSION_ID` still exercises the inside-session path.

### Tests

- The existing daemon lifecycle tests act as the regression; no new behaviour to assert beyond "green in both launch contexts".
- Verify manually: `npm run check` inside a pixip session, and `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check`.

### Notes

- Related, but separate: `06-archive-session-identity`; the spawn-seam env fix already landed in `05-stale-pi-session-env` and does not cover the hub's own CLI test processes.

### Order

First ticket in the `open/hotreload` journey. Do this before any other ticket, otherwise every `/fit work` check is red for an unrelated reason and the journey starts on a false failure.

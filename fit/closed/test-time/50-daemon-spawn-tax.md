---
project: pixip
grilled: true
---

The slowest suite spends its time starting CLI processes: `daemon.test.ts` alone invokes `node bin/pixip.ts` 55 times, and each spawn costs ~0.46 s before it does any work. Cut the number of spawns per assertion and make the cheap CLI paths stop paying for the whole hub import.

### Findings

- `node bin/pixip.ts help` cold: 0.46 s; a bare `import("./src/hub.ts")`: 0.28 s; `import("./src/server.ts")`: 0.43 s.
- `daemon.test.ts` hard restart suite: 28.6 s for 5 tests; daemon lifecycle 21.5 s; `worktree-cli.test.ts` 9.1 s across 12 spawns plus real `git init/add/commit` fixtures.
- 55 spawns &times; ~0.4 s is roughly 22 s of the 28.6 s.

### Decision to grill

Whether to fix this on the test side, the product side, or both. Test side: reuse one daemon across the `refuses/prints/exits` assertions instead of one process per case. Product side: lazy-import hub/server in `bin/pixip.ts` so `stop`, `status`, `help` and the detach helper never load the hub. The product-side change is user-visible in start latency, so it needs the owner's call and a note in `ARCHITECTURE.md` if the numbers move.

### Scope

- Reduce `daemon.test.ts` spawn count to the cases that genuinely need a fresh process; keep the timeout/idle assertions intact (they are the point of the suite).
- If approved, lazy imports in `bin/pixip.ts` for paths that do not need the hub, verified with the same cold-start measurement.
- No shims, no test-only branches in product code; the real `pi` binary path stays untouched.

### Acceptance

- `daemon.test.ts` wall time under 12 s on this box, measured before/after, with no test dropped or weakened.
- If the lazy-import path is taken, `node bin/pixip.ts help` cold start under 0.25 s and the full suite still green.
- The ticket records the spawn count before and after.

### Work order

Fifth: it only shortens the full suite (~20 s), and it is the only ticket here that changes product code (`bin/pixip.ts` imports), so it needs the owner's decision and possibly an `ARCHITECTURE.md` update. Everything above is independent of it, so it can wait.

### Decisions

Grilled 2026-11-21. Answers:

- **Side:** both.
- **Product side:** lazy-import `src/hub.ts` / `src/server.ts` in `bin/pixip.ts` so `stop`, `status`, `logs` and `help` never load them. Keep the serve/daemon/reload paths unchanged. No test-only branches and no shim; the real `pi` binary path is untouched. If the cold-start numbers move, update `ARCHITECTURE.md`.
- **Test side:** reduce `daemon.test.ts` spawns by reusing one daemon across related assertions. Keep every assertion, especially the timeout/idle/when-idle cases; no test may be dropped or weakened. Do not convert to in-process hub assertions for this ticket.
- **Acceptance:** `daemon.test.ts` under 12 s, measured before/after and with spawn count recorded before/after; if lazy imports land, `node bin/pixip.ts help` cold under 0.25 s; full suite still green.
- Commit this ticket as one commit after closing.

### Current state

Product side is done and meets its target:

- `Hub`, `GenerationManager`, `startWatch`, the reload pause helpers, the worktree helpers and the inbox purpose table are now dynamically imported only on the paths that use them.
- `pixip --help` cold: **~170 ms** (was ~420 ms). `status`, `logs`, `stop` are ~160–200 ms each.
- The generation-register hook moved from top-level startup into the serve path.
- Full `npm run check` is green at **157.7 s**.

Test side is partially done:

- The shared `daemon()` setup helper now calls `startDaemon` directly instead of spawning `pixip daemon` (17 CLI spawns removed).
- Teardown `pixip stop` calls became `stopDaemon(dir)` (17 CLI spawns removed), and two non-CLI log checks use `readLogTail` directly.
- CLI spawn count in `test/daemon.test.ts`: **55 → 35**. Daemon starts still **17**.
- `test/daemon.test.ts` isolated: **42.4 s → 34.8 s**.

### Blocker

The 12 s acceptance target cannot be met without expanding beyond the grilled answers. The remaining cost is not CLI startup any more: it is 17 daemon process starts plus 10 real restart operations, each of which detaches a fresh `pixip run` process and waits for health (~1.2–1.5 s each). That is ~30 s before any assertions run.

Hitting <12 s requires one of:

1. **In-process daemon/hub harness** for setup and assertions — explicitly excluded by the grilled answer.
2. **Run daemon tests concurrently** (per-describe concurrency) — not grilled, and risks resource contention/flakiness on this 2-CPU box.
3. **Aggressively merge tests** to share daemons — still leaves ~10 restart operations, so expected floor is ~20 s, not 12 s.
4. **Change restart product behavior** to start faster/not wait — product risk outside this test-time ticket.

The batch is halted here with ticket 50 still in progress; no ticket-50 commit has been made.

### Additional decision (2026-11-21)

After the blocker was raised, the owner chose **run daemon tests concurrently**: "Make a commit right now, then go down this road. If it doesn't noticeable improvements let me know."

- Current work (lazy imports + `startDaemon`/`stopDaemon`/`readLogTail` test reductions) was committed as `4f1229e` before starting this.
- Try per-describe concurrency in `test/daemon.test.ts`, measure isolated wall time and flakiness, and report whether the improvement is noticeable.
- Keep the in-process harness and product restart changes out of this attempt; this is a test-runner scheduling change only.

### Concurrency result

Applied `{ concurrency: 3 }` to all four top-level describes in `test/daemon.test.ts` (lifecycle, backend, reload, hard restart). Each test already uses its own temp data dir, so they can overlap.

- `daemon.test.ts` isolated: **23.29 s** with 27/27 passing (was 34.8 s after the spawn reductions, 42.4 s before ticket 50).
- Tried concurrency 2/4/5/6/8: all landed 23.7–25.3 s; 3 is the best stable setting on this 2-CPU box.
- Tried also running the four describes concurrently (outer `{ concurrency: true }`): 21.8 s but the SIGHUP soft-refresh test flaked, so that was reverted.
- Full `npm run check`: **149.8 s**, green, 502/502 root tests.

The 12 s target is still not met. Hard restart alone is **11.4 s** at concurrency 8 (8 tests, each replacing a daemon), so even perfect overlap of the other describes cannot go below ~11.5 s plus startup. Reaching <12 s reliably requires the in-process harness (excluded earlier) or merging hard-restart scenarios so fewer real restarts run.

The concurrency change is being committed as an improvement while ticket 50 stays open for the owner's decision on the revised target.

### Closure

Closed by owner decision ("Don't let the perfect be the enemy of the good") with the 12 s target explicitly revised rather than met.

Final outcome:

- Product side met its target: `pixip --help` cold is **~170 ms** (was ~420 ms), and `status`/`logs`/`stop` are ~160–200 ms because they no longer load the hub/server graph.
- Test side reduced CLI spawns **55 → 35** and `daemon.test.ts` from **42.4 s → 23.3 s**.
- The 12 s target was not reached. Hard restart alone is 11.4 s and the suite still performs 17 real daemon starts plus 10 restarts; the in-process harness was explicitly out of scope.
- Per-describe concurrency `{ concurrency: 3 }` was kept; running the four describes concurrently was tried and reverted because the SIGHUP test flaked.
- No test was dropped or weakened: 27/27 daemon tests and 502/502 full-suite tests pass.

Pipeline result after the later scheduling work (separate commits, not part of this ticket's acceptance):

- `npm test`: **53.5 s** on this 2-core box, with concurrency sized from `os.availableParallelism()` (24 workers on a 24-core machine).
- `npm run test:fast`: **25.3 s**, 461 tests.
- Full `npm run check`: **120.8 s**, green.

Commits: `4f1229e`, `c61571a`, `8c772cd`, `3c42efc`.

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

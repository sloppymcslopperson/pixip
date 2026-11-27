---
project: pixip
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

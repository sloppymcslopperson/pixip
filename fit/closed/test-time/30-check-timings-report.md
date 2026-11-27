---
project: pixip
grilled: true
---

Nothing in the repo records how long each check step takes, so a 6-minute pipeline was only visible by timing commands by hand, and nobody can say whether a change made it worse. Emit a per-step summary so regressions are obvious and the other test-time tickets have a number to move.

### Findings

Producing the timing baseline took a `bash` loop with `/usr/bin/time` per step, a full `npm test` piped to a file, and a python pass over the TAP `duration_ms` fields to rank the slow files (median 1.3 ms, five files at 75% of suite time). None of that is repeatable by the next agent without redoing the work, and `node --test` TAP durations are double-counted for parent suites, which is easy to misread (a naive sum came out at 219 s for a 109.6 s suite).

The baseline itself lives in the `check-timing` inbox report: 387 s total, of which tests 131 s, four workspace checks 154 s, root lint 41 s, prettier 20 s (now 9.8 s), typecheck 17 s, browser 22 s.

### Decision to grill

Whether this is a script (`tools/check-timings.mjs`), a flag on an existing runner, or just documentation of the incantation in `AGENTS.md`. A script that runs the current `check` and prints per-step wall time (and, on failure, the step that failed) is probably worth more than prose.

### Scope

- A repeatable command that prints one line per step: step name, wall time, exit status, slowest test files.
- Correct handling of nested TAP suites so no duration is counted twice.
- Optional: a soft budget table (step, current, budget) in the script or in `AGENTS.md`, with the ticket noting that a step over budget is a warning, not a failure, unless the owner wants it hard.

### Acceptance

- One command reproduces the baseline numbers on the current tree.
- The output makes the five slow suites and the four workspace constant costs visible without extra shell work.
- No new dependency required; if one is, the ticket says which and why.

### Work order

Third: written after `10-parallel-check-gates` and `20-fast-and-full-test-scripts` so the harness encodes the settled step list and the fast/full split instead of today's serial chain. It is also what makes the before/after claims in `40` and `50` cheap to check.

### Decisions

Grilled 2026-11-21. Answers:

- **Form:** a new `tools/check-timings.mjs` exposed as `npm run check:timings`; no new dependency.
- **Default scope:** the full pipeline equivalent — `check:static`, `test:full`, `check:browser`, and all four workspace checks. No fast mode in this ticket (the fast/full split already exists for the inner loop).
- **Budgets:** a soft table (step, measured, budget). Over-budget is a **warning only**; the exit code reflects actual step failures, not budget overruns.
- **Slow files:** run the full test suite with TAP output and rank each top-level test file once, so nested suites are never double-counted.
- Output is one line per step with name, wall time and status, plus the slowest test files and any budget warnings. A `--json` flag is optional and only if cheap.
- Commit this ticket as one commit after closing.

### Result

Added `tools/check-timings.mjs` behind `npm run check:timings`. It runs the same seven steps as `check` sequentially, buffers output, prints one line per step with wall time/status, and prints a soft budget table. It then reports the slowest top-level TAP suites (nested time counted once) and the slowest test files.

Measured on this 2-CPU box, `PIXIP_CHROME` set, exit 0:

```text
check:static                          40.6s  ok   (budget 55s)
test:full                            107.7s  ok   (budget 170s)
check:browser                         21.4s  ok   (budget 40s)
check --workspace pixip-pi-host       24.4s  ok   (budget 50s)
check --workspace pixip-inbox         28.6s  ok   (budget 50s)
check --workspace pixip-questionnaire 31.9s  ok   (budget 50s)
check --workspace pixip-show-image    28.7s  ok   (budget 50s)
total                                283.2s
```

Slowest top-level TAP suites, directly reproducing the five-suite finding:

```text
26.7s hard restart
14.0s daemon lifecycle
 9.6s backend selection
 8.5s pixip worktree CLI
 8.1s pixip reload
```

Slowest files from the isolated per-file pass: `daemon.test.ts` 92.1s, `worktree-cli.test.ts` 12.0s, `inbox.test.ts` 4.8s, `worktree-hub.test.ts` 4.0s, `archive.test.ts` 3.0s.

Whole command wall time is 382.2 s, consistent with the 387 s baseline. Budgets are warnings only; the exit code follows real step failures.

### Implementation notes

- Node 22.23.5's combined TAP output names top-level *suites*, not files, so file ranking uses a separate bounded per-file pass (2 at a time). The full suite is still timed once as the authoritative `test:full` step; the file pass is diagnostic.
- Top-level TAP parsing reads only unindented `ok`/`not ok` blocks, so a nested test is never counted twice.
- No new dependency; only `node:child_process`, `node:fs/promises`, `node:path` and `node:url`.

### Files

- `tools/check-timings.mjs` (new)
- `package.json` (`check:timings`)
- `fit/in_progress/test-time/30-check-timings-report.md`

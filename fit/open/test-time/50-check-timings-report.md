---
project: pixip
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

---
project: pixip
grilled: true
---

`npm run check` is a strictly serial chain of 11 commands, so ~45 s of pure wait on this box is spent by steps that could run at the same time. Run the four independent gates concurrently, in a cheap-first order so a red formatting or import check reports in seconds instead of after lint.

### Findings

Measured on this 2-CPU box; the full baseline lives in the `check-timing` inbox report, and `30-check-timings-report` makes it reproducible.

- `typecheck` 16.7 s
- `lint` 40.7 s
- `format:check` 9.8 s (after `05-format-docs-out-of-check`)
- `check:imports` 2.6 s

Serial total 69.8 s. All four read the tree and write nothing, so running them together is bounded by `lint` at ~41 s, or less once cache is warm.

### Decision to grill

The owner has not picked an implementation. Options: a tiny `tools/check-parallel.mjs` that spawns the four with `child_process` and interleaves output, `concurrently`/`npm-run-all` as a devDependency, or plain `&`/`wait` in a `bash -c` script. The repo has no bundler and few devDependencies, so a 40-line node script with no new dependency is the obvious candidate.

### Scope

- New `check:static` script running typecheck, lint, format:check and check:imports concurrently; `check` and any fast variant call it instead of the four serial steps.
- Output must stay attributable: prefix or buffer per step so two failing steps are both legible in one run.
- A non-zero from any step makes the whole group non-zero, and the run must not exit early leaving orphaned children.

### Acceptance

- `npm run check:static` exits 0 on a green tree and exits non-zero if any single gate fails (probe each of the four).
- Wall time for the group is under 55 s on this box, measured, and the ticket records before/after.
- No new dependency unless the decision above says otherwise.

### Out of scope

Making the individual steps faster (that is `40-workspace-tooling-once` and `50-daemon-spawn-tax`); only scheduling changes here.

### Work order

First of the test-time tickets: it is the smallest scheduling-only change, and it settles the shape of `check` into a `check:static` group that `20-fast-and-full-test-scripts` and `30-check-timings-report` both build on.

### Decisions

Grilled 2026-11-21. Answers:

- **Implementation:** a tiny `tools/check-parallel.mjs` using `node:child_process`, no new dependency. Not `concurrently`, not a bash `&`/`wait` one-liner.
- **Output:** buffer each step's stdout/stderr, then print every section with a clear `[step]` header when the group finishes, followed by a per-step status/duration summary. No line interleaving.
- **Scope:** exactly the four root gates — `typecheck`, `lint`, `format:check`, `check:imports`. Do not add `check:browser` or the workspace checks to the group.
- **Failure semantics:** wait for all four to finish, report every failure, exit non-zero if any failed. Do not abort siblings early. Still propagate SIGINT/SIGTERM to children so a cancelled run leaves no orphans.
- `check` and `check:fast` both call `check:static` instead of the four serial steps.
- Commit this ticket as one commit after closing (standing autocommit answer).

### Result

Implemented `tools/check-parallel.mjs` with no new dependency. `package.json` gains `check:static`; `check` now starts with `npm run check:static` and keeps the rest of the chain unchanged.

Measured on this 2-CPU box (cold-ish after `npm install`, all four gates green):

- Before, serial from the ticket findings: 69.8 s (`typecheck` 16.7, `lint` 40.7, `format:check` 9.8, `check:imports` 2.6).
- After, concurrent `npm run check:static`: **44.98 s** wall (`check:imports` 3.9, `format:check` 21.4, `typecheck` 31.2, `lint` 44.7). Bounded by `lint`, well under the 55 s acceptance bar.

Failure probes, using a fake `npm` on PATH so each gate could fail independently:

- `FAIL_TYPECHECK=1` → exit 1, summary names `typecheck`
- `FAIL_LINT=1` → exit 1, summary names `lint`
- `FAIL_FORMAT=1` → exit 1, summary names `format:check`
- `FAIL_IMPORTS=1` → exit 1, summary names `check:imports`
- all green → exit 0

The runner waits for every gate before printing its buffered section and summary, and forwards SIGINT/SIGTERM/SIGHUP to its children. Full `npm run check` is green at 298.15 s wall with `PIXIP_CHROME` set.

### Files

- `tools/check-parallel.mjs` (new)
- `package.json` (`check:static`, `check` wiring)
- `fit/in_progress/test-time/10-parallel-check-gates.md`

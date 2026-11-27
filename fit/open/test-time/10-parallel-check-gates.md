---
project: pixip
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

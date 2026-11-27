---
project: pixip
---

Each of the four workspaces runs its own cold typecheck, lint, formatting check and test pass, so the pipeline pays full tool startup five times to test about 8 s of extension code. Typecheck and lint each workspace once, from the root, with information shared between runs.

### Findings

Measured on this box:

| workspace | check wall | of which tests |
| --- | --- | --- |
| pixip-questionnaire | 45.3 s | 2.0 s |
| pixip-inbox | 38.3 s | ~1.5 s |
| pixip-show-image | 35.5 s | ~1.7 s |
| pixip-pi-host | 34.7 s | ~2.0 s |

Breakdown inside `pixip-questionnaire` (the smallest one): eslint 17.7 s, tsc 13.8 s, prettier 1.9 s, tests 2.0 s, npm/process overhead ~9.9 s. The root lint already ignores `pi-host/` and `extensions/`, and each workspace then re-lints from cold.

### Decision to grill

Three routes, not yet chosen:

1. Project references: one root `tsconfig.json` with `references` to five projects, a `tsc -b` build, `tsBuildInfoFile` per project for incremental reuse.
2. Looser: keep per-workspace tsconfigs, add `incremental` plus a shared `tsBuildInfoFile` under `node_modules/.cache`, and run the four `tsc` invocations concurrently.
3. ESLint `--cache` (and/or a single root invocation with `extensions/` and `pi-host/` included) for lint, leaving typecheck per workspace.

Option 3 is the cheapest and probably the biggest single win, since typed linting is the dominant cost; option 1 is the most correct and the most invasive.

### Scope

- Root scripts that typecheck and lint all workspaces, and per-workspace `check` reduced to what genuinely differs (their tests, their formatting).
- Cache and build-info outputs must live somewhere ignored (`node_modules/.cache`, `tmp/`) and must not be committed.
- Keep `npm run check --workspace <name>` working for a single workspace, so a ticket touching one extension can still run just that.

### Acceptance

The four workspace checks together are under 60 s, measured before and after; all 502 plus the workspace tests still run; a clean checkout with no cache still passes; the ticket records which of the three routes was taken and why.

### Notes

Verify that a cache cannot mask a real type error: probe by introducing a bad type in one workspace and confirming the cached run still fails.

### Work order

Fourth: the largest absolute win (~154 s of every run) but the most dangerous, since a shared cache or build-info file can mask a real type error. Sequenced after the scheduling and split work so the cheaper wins land without waiting on this, and after `30-check-timings-report` so the payoff is measurable rather than asserted.

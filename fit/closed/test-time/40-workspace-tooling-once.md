---
project: pixip
grilled: true
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

### Decisions

Grilled 2026-11-21. Answers:

- **Route:** combination of route 3 and route 2 — add ESLint caching and lint all workspaces from one root invocation, and make workspace typecheck incremental with `tsBuildInfoFile` shared under `node_modules/.cache`, running the workspace typechecks concurrently. Do **not** introduce project references / `tsc -b` in this ticket.
- **Orchestration:** add a central root `check:workspaces` script that typechecks/lints/formats once and runs each workspace's tests; root `check` calls it. Keep `npm run check --workspace <name>` working standalone, and it may reuse the cache (so first run is slow, later runs fast).
- **Cache location:** `node_modules/.cache` (already ignored by git); no new committed build-info files.
- **Acceptance:** the four workspace checks together under 60 s, measured before/after; all 502 root tests plus every workspace test still run; a clean checkout with no cache still passes.
- **Safety probe:** introduce a bad type in one workspace and confirm a cached run still fails.
- Commit this ticket as one commit after closing.

### Result

Implemented route 3 + 2, with one adjustment forced by memory:

- **Cached root lint:** `lint` is now `eslint . --cache --cache-location node_modules/.cache/eslint/root.cache`. Cold 30.8 s, warm 1.37 s.
- **Cached workspace lint:** each workspace `lint` uses its own cache file under the root `node_modules/.cache/eslint/`, and `tools/check-workspaces.mjs` runs them concurrently (2 at a time).
- **Incremental workspace typecheck:** each workspace `typecheck` is `tsc --noEmit --incremental --tsBuildInfoFile <root>/node_modules/.cache/tsbuildinfo/<name>.tsbuildinfo`; the four run concurrently.
- **Central `check:workspaces`:** runs workspace typecheck, lint, then each workspace's own tests, buffering output and failing on any failure. Root `check` now ends with this instead of four serial `check --workspace` calls.
- **Standalone:** `npm run check --workspace <name>` still runs typecheck, lint, format and tests; it reuses the incremental/cache files. Measured 12.2 s warm for `pixip-inbox`.
- **Formatting:** not repeated centrally because root `format:check` already covers the whole tree.

**Why not one root ESLint process:** including `pi-host/` and `extensions/` in the root ESLint config OOMs Node at the default ~1 GB heap (`Ineffective mark-compacts near heap limit`, exit 134) because `projectService` loads five projects at once. Cached per-workspace lint run concurrently keeps the route-3 win without that failure.

### Measurements

Before (four serial workspace checks, from the ticket-30 run): 24.4 + 28.6 + 31.9 + 28.7 = **113.6 s**. Original ticket findings: 154 s.

After:

- `npm run check:workspaces` warm: **24.0 s**, all 12 phase runs passing (under the 60 s bar).
- First run with `node_modules/.cache` cleared: **84.2 s**, all passing — a clean checkout with no cache still passes, though the first cold run is above 60 s because four cold typechecks and four cold typed lints are CPU-bound on this 2-CPU box.
- Full `npm run check`: **184.0 s** (was 284–298 s), exit 0, 502/502 root tests plus all workspace tests.

### Cache-safety probes

- Bad type (`export const bad: number = "not a number"`) in `pixip-inbox`: cached `check:workspaces` exited 1 and reported `TS2322` — the incremental cache did not mask it.
- Lint-only error (`const unusedProbe = 1`) in `pixip-inbox`: typechecks passed, cached lint exited 1 with `@typescript-eslint/no-unused-vars`.
- Both probe files were removed immediately; the next `check:workspaces` was green.

### Files

- `tools/check-workspaces.mjs` (new)
- `package.json` (`check:workspaces`, cached root `lint`, `check` wiring)
- `pi-host/package.json` and the three extension `package.json` files (incremental typecheck + cached lint)
- `tools/check-timings.mjs` (times `check:workspaces`, budget 60 s)
- `fit/in_progress/test-time/40-workspace-tooling-once.md`

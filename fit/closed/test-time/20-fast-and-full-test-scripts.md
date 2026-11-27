---
project: pixip
grilled: true
---

Split the suite so the inner loop runs the cheap files and a ticket closes on a full run: a `test:fast` script for the 58 quick files, `test:full` (or `npm test`) for everything, and a `check:fast` that pairs the fast suite with the static gates. This is the owner's "put the major tests behind a special script" request.

### Findings

`npm test` runs 63 files, 502 tests, in 131&ndash;157 s on this box. The distribution is extremely lopsided:

- median test 1.3 ms; 320 of 501 tests finish under 10 ms; 464 finish under 500 ms
- five files carry 82.3 s of 109.6 s of suite time: `daemon.test.ts` (hard restart 28.6 s), daemon lifecycle 21.5 s, `backend selection` 12.8 s, `reload.test.ts` 10.3 s, `worktree-cli.test.ts` 9.1 s
- the remaining 58 files total 27.3 s of file time

So a fast suite that excludes those five files should land near 20 s of wall time, and it still covers the hub, protocol, render, transcript, inbox, worktree-state and command logic.

### Decision to grill

The split mechanism is open: an explicit deny-list or allow-list of files in the script, a naming convention (`*.slow.test.ts`), or a tag/`describe`-level skip. A deny-list in `package.json` is the least magic but drifts as files are added; a convention is self-maintaining but requires renaming. Also to decide: does `check` keep running the full suite (assumed yes), and does a fast ticket close require the full run as part of the definition of done.

### Scope

- `test:fast` and `test:full` (with `npm test` kept as the full one so nothing silently stops running).
- `check:fast` for the inner loop: static gates plus `test:fast`, skipping the browser pass and workspace checks unless asked.
- A note in `AGENTS.md` under "Working the board" saying a ticket closes on the full run, not the fast one.
- Coverage guard: `npm test` must still discover every `test/*.test.*` file, so the fast list cannot quietly become the only suite that ever runs.

### Acceptance

- `npm run test:fast` completes in under 30 s on this box with the same 0-failure result as today for the files it includes.
- `npm test` still runs all 502 tests, and a deliberate failure in an excluded file still fails `npm test`.
- `npm run check:fast` is documented in `AGENTS.md` and measured.
- The ticket records the actual file list of the fast set and the reason it is safe to skip the rest mid-ticket.

### Work order

Second: `check:fast` should call the `check:static` group from `10-parallel-check-gates`, so it wants that landed first. It is the biggest per-ticket relief (131&ndash;157 s suite down to ~20 s for the 58 cheap files) and carries no product risk.

### Decisions

Grilled 2026-11-21. Answers:

- **Split mechanism:** explicit deny-list in `package.json`. No renaming convention and no runtime timing manifest.
- **Fast set:** all `test/*.test.js` and `test/*.test.ts` except `daemon.test.ts`, `backend.test.ts`, `reload.test.ts`, and `worktree-cli.test.ts` (the four filenames that carry the five slow suites, ~82 s of suite time). The remaining 58 files are the fast set.
- **Script names:** keep `npm test` as the full suite so nothing silently stops running, add `test:full` as an alias of it, and add `test:fast` for the deny-listed subset.
- **`check:fast`:** `check:static` (from ticket 10) plus `test:fast`. No browser pass and no workspace checks.
- **`check`:** keeps the full suite.
- **Documentation:** update `AGENTS.md` under "Working the board" to say the fast suite is for the inner loop only and a ticket closes on the full run — and explicitly tell future agents to use the full set at the end of a ticket queue, not the fast one.
- **Coverage guard:** `npm test` must still discover every `test/*.test.*` file, so a deliberate failure in an excluded file fails `npm test`.
- Commit this ticket as one commit after closing (standing autocommit answer).

### Result

Split implemented with a `package.json` deny-list and no helper script:

- `test` / `test:full` — unchanged full glob (`test/*.test.js test/*.test.ts`), so it still discovers every file.
- `test:fast` — same runner with `--test-concurrency=4` and a `find` deny-list for `daemon.test.ts`, `backend.test.ts`, `reload.test.ts`, `worktree-cli.test.ts`.
- `check:fast` — `npm run check:static && npm run test:fast`.
- `AGENTS.md` "Working the board" now says `check:fast` is the inner loop, a ticket closes on the full `npm run check`, and the last ticket in a queue must run the full suite.

Measured on this 2-CPU box:

- `npm run test:fast`: **24.10 s** wall, 59 files, 461 tests, 461 pass / 0 fail. Under the 30 s bar. The default test-file concurrency made it 39.4 s, so `--test-concurrency=4` is part of the script.
- `npm run check:fast`: **67.82 s** wall (`check:static` 44 s dominated by lint + 24 s fast suite).
- Full `npm run check`: **283.79 s** wall, exit 0, full suite **502 tests / 502 pass**, browser check included via `PIXIP_CHROME`.

Fast set (59 files, not 58 — the findings' five slow suites live in four files): every `test/*.test.js` and `test/*.test.ts` except `daemon.test.ts`, `backend.test.ts`, `reload.test.ts`, `worktree-cli.test.ts`. The excluded files carry 41 of the 502 tests and all the CLI/daemon spawn cost; the fast set still covers hub, protocol, render, transcript, inbox, worktree-state and command logic.

Coverage probe: appended a deliberately failing `it` to the excluded `test/daemon.test.ts`, ran the full glob with a `--test-name-pattern` filter, and got exit 1 with the failure at `# tests 63, # fail 1`; restored the file immediately. So an excluded-file failure still fails the full command.

### Files

- `package.json` (`test:full`, `test:fast`, `check:fast`)
- `AGENTS.md` ("Working the board" fast/full note)
- `fit/in_progress/test-time/20-fast-and-full-test-scripts.md`

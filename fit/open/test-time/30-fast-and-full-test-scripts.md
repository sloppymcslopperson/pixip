---
project: pixip
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

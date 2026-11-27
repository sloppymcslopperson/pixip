---
grilled: true
project: pixip
---

`npm run format:check` runs Prettier over the whole tree including Markdown, so a prose edit that leaves trailing spaces or unpadded tables fails `npm run check` before the tests run — currently 8 untracked docs files do exactly that and abort the pipeline after ~78 s. Split prose formatting out of the gate: keep the check on code, and expose Markdown formatting as a separate `format:docs` script that is deliberately run, not enforced.

### Goal

`npm run check` passes or fails on code style only. Markdown is still formattable on request, and a future prose file with trailing whitespace no longer blocks tests, the browser pass, or the workspace checks.

### Decisions (owner, this turn)

- Option 3 of the three considered: "keep markdown formatting as a separate `format:docs` script that isn't in `check`. Keeps the ability to format docs deliberately."
- Rejected: `.prettierignore` with `*.md`/`docs/` (hides the rule from the script, loses any intentional markdown pass), and narrowing `format:check` to code globs alone (loses the deliberate docs entry point).
- Root scripts only. The four workspace `format:check` scripts keep `prettier --check .` in their own directories; their README files are Prettier-clean today, and changing them is not part of this ticket.

### Scope

- `package.json`: `format:check` becomes an explicit code glob (`ts,tsx,js,mjs,cjs,json,css,html`); new `format:docs` checks `**/*.md`. `format` (`prettier --write .`) stays as the deliberate whole-tree rewrite.
- `AGENTS.md`: one rule noting that prose is not part of `npm run check`, so nobody re-adds it or hand-fixes a red docs file.
- No change to `.prettierignore` and no change to Prettier config.

### Acceptance

- `npm run format:check` exits 0 on the current tree, including the 8 unformatted untracked docs files, and still exits 1 for a deliberately misformatted `.ts` file.
- Files under the existing ignore entries (`tmp/`, `fit/`, `pi-host/`, `src/client/vendor/`) stay unchecked by the new globs.
- `npm run format:docs` exits non-zero on the same 8 files, proving prose is checked on demand rather than silently dropped.
- `npm run check` runs past `format:check` into lint, imports, tests, browser and workspace checks instead of aborting at step 3.
- Existing coverage is not lost: every tracked non-Markdown file that the old `prettier --check .` covered is still covered.

### Result

`package.json` now has:

- `"format:check": "prettier --check \"**/*.{ts,tsx,js,mjs,cjs,json,css,html}\""`
- `"format:docs": "prettier --check \"**/*.md\""`

`format` is unchanged (`prettier --write .`), so a whole-tree rewrite, including prose, is still one deliberate command. `.prettierignore` and `.prettierrc.json` are untouched. Code shipped in `2c148b1`; the `AGENTS.md` rule followed once the file was free (see Deviations).

### Coverage check (old vs new file sets)

Enumerated every tracked file with `prettier.getFileInfo` (parser + ignore rules) and compared against the new globs: old set 215 files, new set 207, dropped exactly 8, all of them Markdown (`docs/PRESS-RELEASE*.md`, `docs/archive/pre-prfaq/**`). No non-Markdown file lost coverage; no file under `fit/`, `pi-host/`, `tmp/`, `ui_work/` or `src/client/vendor/` is picked up. Extensions still covered: css, html, js, json, mjs, ts.

Worth recording: 83 of the repo's 91 tracked Markdown files were already unchecked because they live in `fit/`, `pi-host/` or `ui_work/`; only 8 were ever in the gate. So this changes little in practice for prose and removes the failure mode entirely.

### Probes

- `npm run format:check` → exit 0 on the current tree, which still contains the 8 unformatted docs files. 9.8 s, down from 20.2 s.
- Misformatted `src/__fmtprobe.ts` → exit 1, file named in the report; removed after the probe.
- Misformatted `tmp/__fmtprobe.ts` and `src/client/vendor/__fmtprobe.js` → exit 0, not reported.
- `npm run format:docs` → exit 1, naming the same 8 docs files, so prose is checkable on demand.
- Full `npm run check` (with `PIXIP_CHROME` set) → exit 0 in **354.95 s**, past format:check through lint, imports, 502 tests, the 2-viewport browser pass and all four workspace checks.

### Deviations

- The `AGENTS.md` rule was not in `2c148b1`: the file carried another agent's uncommitted edit, and staging it then would have swept unrelated work into that commit. Their change was committed on its own first (`22bc541` "Forbid unrequested daemon restarts"), and this ticket's rule was added afterwards. The rule sits with the other client/build rules: `format:check` covers code only, `format:docs` checks Markdown on demand, and Markdown must not go back into the gate.
- `format:docs` is red on this tree right now (those 8 files). That is the intended state of an on-demand check, not a regression: it is no longer wired into `check`.

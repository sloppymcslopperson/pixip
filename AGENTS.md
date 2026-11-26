<!-- fit:begin -->

## FIT tickets

This repository uses FIT: tickets are Markdown files under `fit/open/`,
`fit/in_progress/`, `fit/backlog/`, and `fit/closed/`. The directory is the
ticket status. Filenames are `NN-short-name.md`: a two-digit priority from
`00` to `99` (`00` first) and a short-name identity that must be unique across
the board.

Mode: no `fit/STRICT` marker means Basic (permissive). A `STRICT` file with the
quoted spec version means Strict, which adds naming, priority, uniqueness,
body, archive, and lifecycle rules. Read [AGENT_SPEC.md](AGENT_SPEC.md) before
working a Strict board.

Workflow: use `fit_list` to find an exact ticket id, read only the ticket you
are assigned, move it to `in_progress` while working, and move it to `closed`
when finished. At most one ticket may be in `in_progress` per checkout. Keep a
1-3 sentence summary, then put everything else under level-3 (`###`) headers.
Pass the `expectedRevision` from `fit_show` to mutations. Use `fit_archive`
for closed tickets that should leave the active board; `fit_restore` brings an
archived ticket back.

Tools: `fit_init`, `fit_list`, `fit_show`, `fit_new`, `fit_new_batch`,
`fit_update`, `fit_move`, `fit_cleanup`, `fit_archive`, `fit_restore`, and
`fit_check`.

Guardrails:

- Prefer dedicated tools over direct manipulation when one exists. For FIT
  operations, use the FIT tools rather than ad-hoc shell or editor changes.
- Do not read ticket files or scan ticket bodies unless the task requires it.
- Do not use `write`, `edit`, or shell commands to create, modify, move, or
  delete files under `fit/`; use the FIT tools.
- Do not guess ticket ids or fuzzy-match them in tool calls. Use exact ids
  from `fit_list` or `fit_show`.
- If a ticket changed since you read it, re-read it instead of forcing a
  write.

<!-- fit:end -->

## pixip

Standalone prototype: a supervisor (`bin/pixip.ts`) plus a static phone-first web
client for `pi --mode rpc` sessions. It is intended to replace AoE for Pi
sessions eventually, and is written so the hub can be ported to Rust without
redesign — read `ARCHITECTURE.md` before changing the protocol, the event path,
or `src/hub.ts` state handling.

```bash
npm install
npm run check                                   # tsc --noEmit + node --test
node bin/pixip.ts --data-dir ./tmp/dev          # http://127.0.0.1:8137/
```

Rules:

- The hub spawns the real `pi` binary. Never add a shim, a private extension API,
  or a plugin-side change: existing Pi extensions must keep working untouched.
  Extension dialogs travel as `extension_ui_request` / `extension_ui_response`.
- Events are forwarded verbatim (`wire.ts` `frameEvent`). Do not parse and
  re-encode a Pi record on the path to the socket; that is both the latency
  budget and the Rust-port boundary.
- `--data-dir` is the test isolation boundary (Pi gets `--session-dir
<data-dir>/sessions`). Never point tests at `~/.pi/agent/sessions`, and never
  attach two processes to one live session file.
- The UI has no authentication. Binding is loopback by default; binding a
  non-loopback address is an explicit opt-in and prints a warning. Do not add a
  public vhost or an unauthenticated `0.0.0.0` default.
- Latency budgets: prompt → `agent_start` under 15 ms local, event → frame in the
  same tick, event → paint within one rAF. If a change costs more, say so in the
  ticket.
- Client assets are served as-is: no bundler, no build step, no framework. Keep
  the client small and keep `src/client/render.js` pure so `test/` can cover it.
- The client is responsive by contract: one asset set, CSS media/container queries
  only, no user-agent branching and no duplicated markup per breakpoint. Every
  layout change must be checked with the `browser` tool (agent-browser) by setting
  the viewport to roughly 360, 390, 768, 1280 and 1600 px, taking a screenshot and
  checking `document.documentElement.scrollWidth <= innerWidth`; a real phone
  confirms, it is not the only evidence. `tools/shot.mjs` is an optional extra
  when a Chrome binary is available via `PIXIP_CHROME`. Widening must add
  information (session cards, rail, context), never stretch one column; anything
  the desktop view shows must come from frames the hub already streams.
- Commits use the repo-local identity already configured here
  (`Sloppy McSlopperson <thesloppyslopperson@gmail.com>`).

## Working the board

`open/` is the work queue, in filename order. Tickets are **not** pre-grilled: the
owner wants the clarifying-question round, so `/fit work` should grill before
implementing (goal, scope, acceptance, files, edge cases, tests, constraints) and
then set `grilled: true` with the answers.

```bash
# in this directory
/fit work 5 autocommit   # the queue: grill each ticket, close it, commit it
/fit work                # one ticket at a time
```

`/fit work` takes in_progress first, then `open/` in priority order. The owner's
standing answer (2026-11-21): close verified tickets and commit one commit per
ticket, so `autocommit` without `review` is the expected mode. Do not pass
`nogrill` — grilling is wanted. Tickets whose decisions are already recorded under
`### Decisions` only need the remaining gaps grilled, not everything again.

Definition of done for every ticket: `npm run check` green, plus a browser check
at 390 and 1280 for anything that touches the client. Use the available `browser`
tool (agent-browser): `set viewport 390 844`, open/screenshot, check for
horizontal overflow, then repeat at `1280 900`. A `check:browser` skip because
`PIXIP_CHROME` is unset is **not** a substitute for this; `tools/shot.mjs` is an
optional extra when a Chrome binary is available. Dev mode (the default) only
reloads client assets; hub or server changes need the daemon restarted (kill the
pid on 8137 and relaunch, or start a second instance on another
`--port`/`--data-dir`). Use `--serious-mode` to serve the startup asset snapshot
instead. If a change moves the numbers in ARCHITECTURE.md, update them there
(that file is the source of truth for the latency budget).

`backlog/` is not a queue: those tickets are either blocked on a human decision
(desktop surface, phone-only ergonomics, auth posture) or deliberately later
(worktrees, fork/clone, theme tokens).

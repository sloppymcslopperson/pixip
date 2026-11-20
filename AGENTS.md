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
- Commits use the repo-local identity already configured here
  (`Sloppy McSlopperson <thesloppyslopperson@gmail.com>`).

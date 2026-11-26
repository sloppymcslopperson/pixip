---
grilled: false
project: pixip
series: chipwitch
---

Add `pixip ref <tag>` so any agent can turn a ref into role, time, session, cwd, branch and truncated text, with `--json` for tooling, using the offline Hub path the CLI already has.

### Scope

- Accepts the bracketed tag verbatim (so a straight paste into a shell works) and the bare address.
- History by entry id, reusing the bounded backward read behind `entry()` (`src/hubControl.ts`); the `msg:` form resolves by the same coverage key the client derives.
- Inbox refs read `<data-dir>/inbox.json` (including archived), and report a deleted message as unavailable rather than empty.
- Archived sessions resolve through the archive store metadata. Unknown or unavailable refs exit non-zero with a clear message.
- No daemon required: index plus JSONL, the same offline path `pixip worktree list` already uses.

### Decisions

- Output is a header (kind, session name, role, time, cwd, branch) followed by the text capped at ~4 KB with an explicit truncation note.
- Exit codes follow the worktree CLI: `2` for a safe refusal (unknown, archived-away, deleted), `1` for usage errors.

### Acceptance

- `pixip ref '[ref=history/…]'` prints header and text for a live, a stopped and an archived session.
- `pixip ref '[ref=inbox/…]'` prints subject, purpose, sender and body; a deleted id exits `2`.
- `--json` emits a stable shape an extension could reuse later.
- `--help` lists the verb; `npm run check` green.

### Open

- Whether this stays in the queue or is demoted to `backlog/` if the `sessions.json` + `rg` fallback proves good enough in practice.

### Boundaries

- Additive CLI surface only: one new `ref` verb. Do not rename or restructure `run`/`daemon`/`serve`/`restart`/`refresh` — `pixip/hot-reload` owns that rename, so expect a conflict in the arg parser and resolve by keeping both.
- No daemon route, no protocol change, and no writes to the data dir from this verb.
- Keep resolution in a new module (for example `src/refResolve.ts`) plus the existing `src/jsonl.ts` readers. Do not grow `src/hubControl.ts` for CLI-only needs.
- Same hot-reload fence otherwise: `src/daemon.ts`, `src/hub*.ts`, `src/wire.ts`, `fit/*/hotreload/`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `node --test test/ref-cli.test.ts` against a fixture data dir holding one live, one stopped and one archived session, one inbox message and one deleted inbox id (exit `2`).
- Resolution must be proven offline: run it with this worktree's daemon stopped, using `--data-dir ./tmp/refs`, so no REST path can mask a broken JSONL read.
- `npm run check` green, and `--help` must list the verb (existing CLI tests assert the help output).
- Manual cross-check: a tag produced by ticket 10 resolves and prints the same text the user copied from.

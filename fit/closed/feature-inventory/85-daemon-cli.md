---
area: daemon-cli
part: inventory
project: feature-inventory
commit: a9af04ee092c662720ffcd11fa253cb2cef753c0
---

Capture the operator experience: starting and supervising the pixip daemon, session survival, data-dir isolation, backend selection, and the CLI verbs. This is the server-side product surface that a rewrite must not lose.

### Goal
An inventory reader should understand how pixip runs as a long-lived service, how an operator controls it, and what guarantees sessions rely on.

### Scope
- `pixip run` in the foreground vs `daemon`, `stop`, `status`, `logs`, `refresh`, `restart`; pid, state and log files under `--data-dir`.
- `restart --when-idle` as safe self-update, and live-session survival across a restart.
- Idle detach (`--idle-ms`), stopped-session listing, and reattach on open.
- `--data-dir` as the test/session isolation boundary, `--session-dir` mapping, and never touching the user's real sessions.
- Backend selection: embedded `pixip-pi-host` by default, `--use-system-pi` with `--pi`/`PIXIP_PI`, and fail-fast when the host is missing.
- Bind address, loopback default, non-loopback opt-in warning, and the no-auth posture.
- Relevant CLI verbs for worktrees and refs, cross-linked to their sections rather than repeated.
- Environment variables and config that affect startup.

### User stories to cover
- As an operator, I want to start pixip once, check it is alive, tail logs and restart it without losing sessions.
- As an operator, I want a restart that waits for idle work instead of interrupting an agent.
- As an operator, I want a scratch data dir for tests or a second instance.
- As an operator, I want to choose the embedded host or a system Pi binary, with a clear error when one is missing.
- As a security-conscious operator, I want a loopback default and an explicit warning before binding wider.

### Wireframes (SVG, no screenshots)
- Series of screens: terminal operator flow for run/daemon/status/logs/restart, and the dashboard's relationship to the daemon.
- Decision-flow diagram: start -> foreground/daemon; restart -> when-idle or wait; backend -> host vs system pi; bind -> loopback vs opt-in.

### Technical notes (port-relevant only)
- Process supervision, pid/lock ownership, and what persists across restart (live set vs JSONL).
- Why agent-initiated restart is refused and SIGHUP is ignored.
- The data-dir contract and the port/backend boundary.

### Sources to read
`bin/pixip.ts`, `src/daemon.ts`, `src/dirs.ts`, `src/backend.ts`, `src/spawnEnv.ts`, `src/hubControl.ts`, `src/reload/*`, `README.md` daemon, `ARCHITECTURE.md` reload/restart and backend boundary.

### Acceptance
- Every CLI verb and startup flag that affects behaviour is covered.
- Session survival, idle detach and restart-when-idle are explicit.
- Bind/auth posture is stated as a constraint, not a feature to preserve blindly.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/85-daemon-cli.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

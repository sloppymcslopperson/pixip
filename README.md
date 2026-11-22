# pixip

`pi` × `ip`: a phone-first web view of Pi sessions. Not a terminal mirror — a
transcript, streamed from real `pi` processes, that reflows, scrolls natively and
has a normal text box instead of a pane grid.

Prototype. Single supervisor process (`pixip`) + static client, no build step.

| phone | desktop |
|---|---|
| ![phone](docs/phone-session.png) | ![desktop](docs/desktop-session.png) |

```bash
npm install
node bin/pixip.ts --data-dir ./tmp/dev        # http://127.0.0.1:8137/
```

`--data-dir` is the isolation boundary: Pi runs with `--session-dir
<data-dir>/sessions`, so pointing it at a scratch directory never touches
`~/.pi/agent/sessions`.

## Why

Existing options are slow, shaped around terminals or editors, and some of them
need plugins rewritten to work:

| | Substrate | What it costs |
|---|---|---|
| AoE | tmux + PTY | web UI mirrors a terminal: fixed columns, copy mode, chords on a phone; agent-agnostic so Pi's structure is lost |
| pi-web | spawns pi over WS | one process, no lifecycle (stop/restart/fork), sessions die with the server |
| pi-acp / ACP | one adapter per session | editor-shaped; a session belongs to one client |

pixip is built on `pi --mode rpc`: a long-lived Pi subprocess with a JSON command
and event stream. That means **no PTY, no tmux, no terminal emulation**, and
**every existing Pi plugin keeps working unchanged** — the supervisor runs the
real `pi` binary, so extensions, skills, prompts and themes load exactly as they
do in the TUI.

## Goals

1. **Fast, in both senses.** Hub overhead in single-digit milliseconds
   (measured: prompt→`agent_start` 6 ms, prompt→user echo 18 ms, stop 46 ms), and
   a UI that stays responsive on a phone: append-only DOM, rAF-batched deltas,
   raw event passthrough (no server-side re-encoding), one websocket, no polling,
   no framework, ~25 KB of JS.
2. **Ergonomic on a phone, and responsive by contract.** Native scroll, soft-wrap
   with no horizontal scroll, 16 px input (no iOS zoom), sticky composer,
   safe-area padding, tap targets, collapsed tool output, approvals as a bottom
   sheet instead of "go find the terminal". One asset set serves every width:
   the phone layout is verifiable by resizing a desktop browser, and a wide
   window is expected to show *more* (session cards or a rail), not a stretched
   single column.
3. **Pi's semantics, not a byte stream.** Messages, thinking, tool calls and
   results, compaction notices, `session_info_changed` — the things a terminal
   hides in scrollback.
4. **Multi-session by construction.** The supervisor owns sessions: list, attach,
   detach, stop, resume. That is impossible from inside a single session's
   plugin, which is why this is a process and not an extension.
5. **Cheap on a small box.** An idle session is detached after `--idle-ms`
   (default 15 min); its JSONL stays and `--session <file>` resumes it on demand.

## What works today

- session list grouped by cwd with collapsible sections (collapsed by default),
  live state (idle/busy/stopped/error), create from a typed path, from the
  home-fenced directory picker (`browse`), or from a group's `+`, open, stop,
  wake/reattach; collapsing keeps hot/warm sessions and each group's newest
  session visible by default, configurable from the header gear;
- first-prompt session labels: a separate one-shot Pi call summarizes the first
  prompt to 3-5 words (`--title-model` / `PIXIP_TITLE_MODEL` overrides the
  current session model; local fallback), while a manual rename always wins;
- streamed transcript: user/assistant text, thinking collapsed, tool calls with
  ANSI output, error styling, durations;
- composer: send while idle, steer while streaming, abort via `stop`; a `+`
  menu attaches one image (camera/library, downscaled client-side) or one
  arbitrary file (uploaded under `<data-dir>/uploads/` and handed to Pi as a
  path), with an inline removable preview and clipboard paste;
- `!cmd`/`!!cmd` bash cards (streamed output, exit code, `!!` excluded from the
  model context), slash-command passthrough for extension commands/templates/
  skills, and a restrict-only per-session command policy (`pixip.json`,
  `--allow-command`/`--deny-command`/`--no-bash`) — see `docs/parity.md`;
- the RPC-drivable built-ins from the composer: `/compact`, `/name`, `/session`,
  `/copy`, `/model`, `/thinking`, `/new`, `/resume`, `/quit`;
- per-session model and thinking level, picked from the footer (`get_available_models`
  / `set_model`, `get_available_thinking_levels` / `set_thinking_level`);
- the TUI status line: pwd + branch + session name, token totals, cost, context
  usage with the TUI's thresholds, and `model • thinkingLevel`;
- transcript text size: `A−`/`A+` in the header, seven steps from 50 % to 150 %,
  device-local (`localStorage`), scaling only the transcript so the composer and
  the rest of the chrome stay fixed (long-press resets, `Ctrl/Cmd` `-`/`+`/`0`);
- dashboard settings sheet from the header gear, with a device-local toggle for
  keeping hot/warm and newest sessions visible in collapsed groups, plus
  `archived` and `trash` views (restore or permanently delete);
- session archive/delete from each row's actions menu, with a short delete undo,
  and an `archive inactive` action for every stopped session;
- extension dialogs (`select`/`confirm`/`input`/`editor`) rendered as a sheet and
  answered from the phone; `notify` as a toast;
- reconnect with backoff, durable entry-cursor resume and a stable pixip logical
  session id per session, so a dropped phone misses no entries;
- sessions that were never prompted still list after detach (session index);
- daemon lifecycle: `pixip start|stop|status|logs|refresh|restart` with pid,
  state and log under `--data-dir`; soft refresh re-reads assets, command policy
  and the session index without touching live children, and a `reload` action in
  the header does the same from the phone;
- `restart --when-idle` as the safe self-update, with sessions surviving in their
  JSONL;
- test isolation via `--data-dir`.

TUI command parity is the current focus (developing pixip inside pixip); see
[`docs/parity.md`](docs/parity.md) for the command-by-command coverage map and the
tickets that own each gap.

## Running as a daemon

Bare `pixip` still serves in the foreground; the CLI manages a detached process:

```bash
pixip start --data-dir ./tmp/dev          # prints the URL, writes pid/state/log
pixip status [--json]                     # non-zero when not running
pixip logs [-f] [--lines 200]             # tails <data-dir>/pixip.log
pixip refresh                             # soft: assets, policy, session index
pixip restart [--force] [--when-idle]     # replace the process, JSONL survives
pixip stop
```

`--data-dir` owns everything (`pixip.pid`, `pixip.state.json`, `pixip.log`,
`sessions/`), so parallel instances on another `--port`/`--data-dir` never
collide. One process owns a data dir at a time: the bare foreground command
refuses to start when a daemon already owns it. Soft refresh (`pixip refresh`, `SIGHUP`, or the header's `reload`) keeps
children and sockets, and its endpoint is loopback-only because the UI has no
auth. Hard restart refuses while a session is busy unless `--force`;
`--when-idle` waits up to `--timeout` seconds (default 300, exit 2) for the other
sessions and is the safe way to pick up hub changes from inside pixip: the
stop/start runs in a detached helper that survives the calling session, and
`pixip stop` issued from inside a session restarts instead of taking the service
down (use a shell outside pixip to really stop it). The phone reconnects with
backoff and its durable cursor, and sessions reattach from their JSONL.

## Not yet

- TUI visual parity: diff/syntax colouring and the TUI's own theme colours (theme
  values are `okhsl`, which browsers do not support without conversion — see
  `85-theme-tokens`);
- worktree creation, input history and `@file` completion;
- virtualised transcript for very long sessions;
- auth of any kind (bind loopback, or a private VPN interface — same posture as
  `aoe serve --host 100.42.42.1 --auth none`).

## Checking the layout

The responsive contract is verified by resizing, not by owning a phone. With any
Chromium/Chrome binary:

```bash
PIXIP_CHROME=/path/to/chrome node tools/shot.mjs http://127.0.0.1:8137/ 390 844 phone.png
PIXIP_CHROME=/path/to/chrome node tools/shot.mjs http://127.0.0.1:8137/ 1280 900 desktop.png
```

It prints the box model of the header/list/log/composer (so a resize is asserted,
not eyeballed), flags horizontal overflow, console errors and page errors, and
writes the screenshot. Use `--dev` on the daemon so CSS/JS edits need no restart.

## Layout

```
bin/pixip.ts        supervisor entry: flags, data dir, signals
src/rpc.ts          `pi --mode rpc` peer: LF framing, id correlation, raw records
src/hub.ts          session registry, spawn/attach/stop, idle policy, disk scan
src/commands.ts     per-session command policy: read, validate, merge, serve
src/daemon.ts       pid/state/log, detach, health, soft refresh, restart decision
src/wire.ts         hub <-> browser frames (v1)
src/server.ts       http + ws, static client
src/client/         index.html, style.css, app.js, render.js and commands.js
                    (the last two are pure and unit-tested)
test/               protocol/rpc tests and ANSI/render tests
```

Work is tracked on a strict FIT board in `fit/` (backlog holds the known gaps
from "Not yet"). See [AGENTS.md](AGENTS.md) for the rules that apply to changes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants, the wire protocol, measured
latency, the memory policy, and the Rust-port map.

## Relationship to AoE

Eventually this replaces AoE for Pi sessions. Not yet, and not co-running: two
supervisors over the same repo will disagree about worktrees and session
ownership. AoE keeps working untouched until pixip covers the same ground.

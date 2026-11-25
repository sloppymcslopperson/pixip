# pixip

`pi` × `ip`: a phone-first web view of Pi sessions. Not a terminal mirror — a
transcript, streamed from real `pi` processes, that reflows, scrolls natively and
has a normal text box instead of a pane grid.

Prototype. Single supervisor process (`pixip`) + static client, no build step.

| phone                            | desktop                              |
| -------------------------------- | ------------------------------------ |
| ![phone](docs/phone-session.png) | ![desktop](docs/desktop-session.png) |

```bash
npm install
node bin/pixip.ts --data-dir ./tmp/dev        # http://127.0.0.1:8137/
```

`--data-dir` is the isolation boundary: Pi runs with `--session-dir
<data-dir>/sessions`, so pointing it at a scratch directory never touches
`~/.pi/agent/sessions`.

`pi-host/` is an optional workspace package, `pixip-pi-host`: an embedded Pi RPC
host that pixip can use instead of spawning `pi --mode rpc`. It adds a blocking
`panel` UI request for A2UI while otherwise keeping Pi RPC v1. See
[pi-host/README.md](pi-host/README.md). It is opt-in:

```bash
node bin/pixip.ts --data-dir ./tmp/dev --pi-host  # resolve the workspace bin
node bin/pixip.ts --data-dir ./tmp/dev --pi-host /path/to/pixip-pi-host
PIXIP_PI_HOST=/path/to/pixip-pi-host node bin/pixip.ts --data-dir ./tmp/dev
```

Without `--pi-host`/`PIXIP_PI_HOST`, pixip keeps using `pi --mode rpc`.

The host embeds the project-local Pi SDK, shares the user's Pi agent dir and
extension set for now, and is **not yet the default backend**. Plugin/config
isolation is tracked in `90-pi-plugin-isolation` on the board.

### Inline panels and questionnaires

Blocking `panel` requests from the host render in a collapsible surface between
the transcript and the composer, not as a modal. A2UI v1.0 surfaces use a
vendored renderer that is fetched only when the first panel arrives; extension
dialogs stay a bottom sheet. The hub never parses A2UI, and completed surfaces
are not written to session history (a pending panel replays on reattach).
Questions are not cancelled just because the browser is closed: the hub waits
5 hours detached or 10 hours with a browser attached, then records a timed-out
request so the session can offer a re-ask when it is reopened.

`extensions/pixip-questionnaire` registers the `questionnaire` tool with a
widget-shaped schema (`choice` or `text`). Transport order is A2UI inline panel
(when the host has one) → TUI custom UI → sequential dialogs, with the ACP
"Answer this in chat" hand-off on hosts that cannot collect typed text. It is a
local checkout, unpublished:

```bash
pi install /path/to/pixip/extensions/pixip-questionnaire
```

It replaces `pi_questionare` for pixip sessions, but nothing uninstalls the old
package for you. Once the new tool works for you, remove the old one; removal
only affects that user's Pi settings (or the project settings for `-l`):

```bash
pi list
pi remove /path/to/pi_questionare
```

`extensions/pixip-show-image` registers `show_image_to_user`, the agent's
explicit way to show one local image in the transcript. Pixip renders it as a
thumbnail on the tool card; a plain Pi TUI keeps the `file://` link. Install it
the same way:

```bash
pi install /path/to/pixip/extensions/pixip-show-image
```

## Why

Existing options are slow, shaped around terminals or editors, and some of them
need plugins rewritten to work:

|              | Substrate               | What it costs                                                                                                    |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AoE          | tmux + PTY              | web UI mirrors a terminal: fixed columns, copy mode, chords on a phone; agent-agnostic so Pi's structure is lost |
| pi-web       | spawns pi over WS       | one process, no lifecycle (stop/restart/fork), sessions die with the server                                      |
| pi-acp / ACP | one adapter per session | editor-shaped; a session belongs to one client                                                                   |

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
   window is expected to show _more_ (session cards or a rail), not a stretched
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

- session list grouped by repository and worktree with collapsible sections
  (collapsed by default), live state (idle/busy/stopped/error), create from a
  typed path, from the home-fenced directory picker (`browse`), from a group's
  `+`, or as `new with worktree`, open, stop, wake/reattach; collapsing keeps
  hot/warm sessions and each group's newest session visible by default,
  configurable from the header gear;
- first-prompt session labels: a separate one-shot Pi call summarizes the
  substantive task in the first prompt to 3-5 words, ignoring slash-command
  boilerplate (a command is labeled from the user message it expands into;
  `--title-model` / `PIXIP_TITLE_MODEL` overrides the current session model;
  local fallback), while a manual rename always wins;
- streamed transcript: user/assistant text, thinking collapsed, tool calls with
  ANSI output, error styling, durations;
- composer: send while idle, steer while streaming, abort via `stop`; a `+`
  menu attaches one image (camera/library, downscaled client-side) or one
  arbitrary file (uploaded under `<data-dir>/uploads/` and handed to Pi as a
  path), with an inline removable preview and clipboard paste;
- `!cmd`/`!!cmd` bash cards (streamed output, exit code, `!!` excluded from the
  model context), slash-command passthrough for extension commands/templates/
  skills, and a restrict-only per-session command policy (`pixip.json`,
  `--allow-command`/`--deny-command`/`--no-bash`) — see `docs/TUI-parity.md`;
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
  and an `archive inactive` action that keeps the newest session in any group
  that has no active sessions;
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
[`docs/TUI-parity.md`](docs/TUI-parity.md) for the command-by-command coverage map and the
tickets that own each gap.

## Install and run

For a machine that should keep pixip running across crashes and reboots, install the
generated systemd unit instead of writing one by hand:

```bash
npm install
node bin/pixip.ts service install      # user unit, ~/pixip_data
node bin/pixip.ts service status
```

The user unit lives at `~/.config/systemd/user/pixip.service`, runs as you, and
logs to `~/pixip_data/pixip.log`. Install tries `loginctl enable-linger`; if it
cannot, it prints the one command needed for boot startup:

```bash
sudo loginctl enable-linger "$USER"
```

Use `--data-dir <path>` to keep the service data somewhere else, and `--replace`
to overwrite an existing unit. `node bin/pixip.ts service uninstall` stops and
removes the unit but keeps the data dir; add `--delete-data` to remove it too.

For a system-wide unit:

```bash
sudo node bin/pixip.ts service install --system
```

With no `--user`, that uses the unprivileged `pixip` account (created with a
login shell and its own home when missing) and asks first on a terminal. Use
`--user <name>` for an existing account or `--user self` for `SUDO_USER` /
the current user. The unit still runs as that user, not root.

The installer uses the repo's vendored Pi (`node_modules/.bin/pi`) when `--pi` is
omitted. If the service account cannot execute the installer's node binary (for
example nvm under a `0700` home), it copies node to
`/usr/local/lib/pixip/node` and points the unit there automatically.

An agent inside pixip can run `pixip restart` (and `pixip stop`, which restarts
from inside a session): it keeps the busy / `--when-idle` checks and then asks
systemd to restart the unit instead of spawning a second daemon. A user unit
needs no extra privilege. For a system unit, allow only that one unit through a
narrow polkit rule (do not grant blanket sudo):

```js
// /etc/polkit-1/rules.d/50-pixip-service.rules
polkit.addRule(function (action, subject) {
	if (
		action.id == "org.freedesktop.systemd1.manage-units" &&
		subject.user == "pixip" &&
		action.lookup("unit") == "pixip.service"
	) {
		return polkit.Result.YES;
	}
});
```

The UI has no authentication. Keep the default loopback bind and open
<http://127.0.0.1:8137/> locally; do not expose the port or bind `0.0.0.0` without
putting authentication and TLS in front of it.

## Running as a daemon

Bare `pixip` still serves in the foreground; the CLI manages a detached process:

```bash
pixip start --data-dir ./tmp/dev          # prints the URL, writes pid/state/log
pixip status [--json]                     # non-zero when not running
pixip logs [-f] [--lines 200]             # tails <data-dir>/pixip.log
pixip refresh                             # soft: assets, policy, session index
pixip restart [--force] [--when-idle]     # replace the process, JSONL survives
pixip protect [<session-id>] [--off]      # exclude a session from bulk archive
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

`pixip protect` marks one session as excluded from the dashboard's bulk archive
(the protected row shows a purple dot). With no id it uses the caller's
`PIXIP_SESSION_ID`, so an agent can protect its own session; `--off` clears it,
and the flag is stored in the session index so it survives restarts and
archive/restore. The explicit `archive` action still works on a protected
session.

## Worktrees

A session can run in a fresh git worktree, or join any directory that already
has a live agent. The dashboard's `new with worktree` creates one from the main
repo's current `HEAD`; a repo group's `+` menu offers it too. The directory is
`<repo-parent>/pixip_worktrees/<repo-name>/<slug>`, the branch is
`pixip/<slug>`, and the slug is editable in a confirm step before creation. A
worktree group's `new` starts another agent in the same directory with no git
mutation; manually opening a session at a worktree path detects the same
metadata. Several agents may share any cwd (worktree or plain directory), with
a dismissible notice naming the peers.

The CLI inspects the same data without the UI:

```bash
pixip worktree list [<repo-or-path>] [--json]
pixip worktree remove <path> [--force]
pixip worktree prune [<repo-or-path>]
```

`list` defaults to the current directory and shows repo, path, branch, owner
(`pixip` or `external`), live agent count, dirty state and session names. It uses
the running daemon when one owns the data dir, and reads the index directly when
none is running. `remove` takes the exact worktree root; `--force` discards
uncommitted changes. Removal is never automatic: stop, archive and session
delete leave the tree alone. A tree referenced by any listed session, or an
external tree that pixip did not create/mount, is always refused, even with
`--force`. Refusals exit `2`; usage, git and daemon errors exit `1`.

**Worktrees are not a sandbox.** They are parallel working directories, not
isolation: agents share your user, network, credentials and the rest of the
filesystem. Use a container or a separate VPS when you need a security boundary.

## Not yet

- TUI visual parity: diff/syntax colouring and the TUI's own theme colours (theme
  values are `okhsl`, which browsers do not support without conversion — see
  `85-theme-tokens`);
- input history and `@file` completion;
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

`tools/browser-check.mjs` covers the main client flows (dashboard open,
composer submit, inline `select`, A2UI fixture panel, transcript windows) with an
in-process fixture Hub and the real client assets:

```bash
PIXIP_CHROME=/path/to/chrome npm run check:browser
```

It runs at 390x844 and 1280x900 and fails on page errors, console errors or
horizontal overflow. `npm run check` includes it; without `PIXIP_CHROME` it
prints a skip and exits 0 so a box without Chromium stays green.

`tools/check-client-imports.mjs` is the client import guard (`npm run
check:imports`): no cycles, nothing imports `app.js`, and only `app.js`/`frames.js`
may import feature modules. Its cluster map is the source of truth for the
dashboard/session/composer boundaries; see the module map in `ARCHITECTURE.md`.

## Layout

```
bin/pixip.ts        supervisor entry: flags, data dir, signals
src/rpc.ts          `pi --mode rpc` peer: LF framing, id correlation, raw records
src/backend.ts      spawn seam: default Pi RPC child, replaceable by `pixip-pi-host`
src/hub.ts          Hub facade: session registry, attach/stop, idle policy, re-keying
src/hubLive.ts      per-child lifecycle, records, pending UI, footer, idle timers
src/hubStore.ts     index, JSONL scan, archive/trash store and restore
src/hubControl.ts   snapshot/history, prompt/steer, queue/bash, policy, soft refresh
src/hubSession.ts   model/thinking/name, tree/fork/clone/import, new/re-key, UI replay
src/jsonl.ts        pure JSONL parse/window/truncate and coverage keys
src/sessionIndex.ts index/archive/trash record types and normalization
src/commands.ts     per-session command policy: read, validate, merge, serve
src/daemon.ts       pid/state/log, detach, health, soft refresh, restart decision
src/wire.ts         hub <-> browser frames (v1)
src/server.ts       http + ws, static client
src/client/         index.html, split CSS, and app/dashboard/session/transcript/
                    sheets/composer/menu/controls/toast/transport modules
tools/              layout/browser checks and the import-graph guard
test/               shared harness plus protocol/rpc/ANSI/render tests
```

Work is tracked on a strict FIT board in `fit/` (backlog holds the known gaps
from "Not yet"). See [AGENTS.md](AGENTS.md) for the rules that apply to changes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for invariants, the wire protocol, measured
latency, the memory policy, and the Rust-port map.

## Relationship to AoE

Eventually this replaces AoE for Pi sessions. Not yet, and not co-running: two
supervisors can both manage worktrees, but each owns only the sessions it
started, so a session cannot be controlled from the other. AoE keeps working
untouched until pixip covers the same ground.

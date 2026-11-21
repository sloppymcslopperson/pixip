# Architecture

Goal: a supervisor plus a browser client for `pi --mode rpc`, small enough to
port to Rust without redesign, and fast enough that the UI never feels like a
remote terminal.

## Invariants

1. **No PTY, no terminal emulation.** The unit of data is Pi's structured record
   (message, delta, tool execution, UI request), never a byte stream of screen
   cells. This is what removes tmux-shaped impedance.
2. **Events are never re-encoded.** `src/rpc.ts` parses a line to correlate
   responses, then hands the *original string* to the hub. The hub splices it into
   `{"t":"event","ev":<raw>}`. In Rust this is `serde_json::value::RawValue`; the
   hub never builds a value tree for the hot path.
3. **Pi's JSONL files are the source of truth.** The hub keeps process state, not
   conversation state. Restart the hub, or detach an idle session, and
   `--session <file>` brings it back.
4. **Bounded memory.** No transcript history server-side: the client gets a
   snapshot from `get_entries` and then deltas. Tool output is forwarded once, not
   retained.
5. **Plugin transparency.** The hub spawns the real `pi` binary with the user's
   own settings. No shims, no plugin rewrites, no private extension API. An
   extension that calls `ctx.ui.confirm` gets `extension_ui_request` on stdout,
   which the phone answers, which goes back as `extension_ui_response`. That path
   is exercised today (the smoke test observes extension UI requests arriving over
   the socket).
6. **Isolation for development.** `--data-dir` sets `--session-dir`; nothing in
   `~/.pi/agent/sessions` is read or written by tests.

## Data flow

```
 phone browser                    hub (pixip)                     pi child
 ─────────────                    ───────────                     ─────────
 open /ws?session=<id> ──────▶  attach()
                                  ├─ read JSONL tail ───────────┐ (200 entries,
                                  │                             ▼  state "starting")
 bytes ◀─ provisional snapshot ───┤
                                  ├─ spawn pi --mode rpc ───────▶  process
                                  ├─ get_state           ───────▶  session id
                                  └─ get_entries         ◀───────  snapshot
 bytes ◀───── snapshot frame ────┤
                                  │  stdout line (raw)  ◀────────  event
 bytes ◀── {"t":"event","ev":…} ──┤  (no parse/re-encode)
 {"t":"prompt","text":…} ───────▶ ┤─ prompt              ───────▶  command
                                                                    │
 {"t":"ui","id":…,"value":…} ───▶ ┤─ extension_ui_response ──────▶  ctx.ui
```

One child process per *attached* session. `--idle-ms` detaches it; the list still
shows the session as `stopped` from the JSONL header, and opening it reattaches.

Opening a session is a two-step paint. The hub reads the JSONL tail **before**
spawning (`src/hub.ts` `provisional()`): the last 200 entries, reading backwards
until ~256 KB of raw line bytes, whichever bound comes first, with each entry's
text truncated to 8 KB and marked as such. That snapshot goes out with
`state: "starting"`, so the transcript is readable while the child boots. When
`get_state`/`get_entries` answer, the authoritative snapshot replaces it, windowed
hub-side to the newest 200 entries (`get_entries` can be 17 MB; it never crosses
the socket whole). Older history comes from the JSONL through `earlier` windows of
200 entries. The client keeps windows the user already loaded, dedupes by entry id
and holds `scrollHeight - scrollTop` constant so a prepend never moves the view.

Transient states are explicit: `starting` (child booting, provisional paint),
`busy` (agent running), `idle`, `stopped` (JSONL only), `error` (child died).

A stopped session keeps its name: the disk scan reads the JSONL header (first
line) plus `session_info` records from the first ~20 lines and from a bounded
16 KB tail, so a rename late in the session still shows. Header and name share
one mtime-cached entry per file; no whole-file read is needed to list.

## Wire protocol v1

All frames are JSON text on one websocket. `v` is bumped on breaking change.

Hub → client:

| frame | fields | notes |
|---|---|---|
| `hello` | `v`, `sessions`, `defaultCwd` | sent on a session-less socket |
| `sessions` | `sessions` | list refresh |
| `snapshot` | `session`, `entries`, `leafId`, `more`, `replace?` | (re)places the window; `more` = older entries exist, so "load earlier" is offered; `replace` drops windows loaded before a compaction or `/new` |
| `history` | `entries`, `more` | answer to `earlier`: the window just before the oldest held entry |
| `status` | `session` | state/name/model changes |
| `event` | `ev` | **verbatim** Pi record |
| `opened` | `session`, `rekey?` | reply to `create`; `rekey` when `/new` moved the session to a new Pi id |
| `copy` | `text` | answer to a `copy` frame: Pi's last assistant text (`null` if none) |
| `policy` | `policy` (`allow`, `deny`, `bash`) | effective per-session command policy |
| `commands` | `commands` (`name`, `description?`, `source`) | live `get_commands` entries for the `/` menu; sent once per attach, cached by the client |
| `bash` | `id`, `command`, `excludeFromContext`, `output`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath?`, `error?` | terminal result for `!`/`!!`; chunks arrive as `event` |
| `error` | `message` | protocol/command failure |

Client → hub:

| frame | fields | maps to |
|---|---|---|
| `create` | `cwd`, `name?` | spawn a new session |
| `prompt` | `text`, `streamingBehavior?` | `prompt` (`"steer"` while busy: extension commands must still execute) |
| `steer` | `text` | `steer` (plain text only) |
| `bash` | `id`, `command`, `excludeFromContext` | `bash`; `id` is repeated on streamed updates and the final frame |
| `compact` | `instructions?` | `compact` (`customInstructions`) |
| `set_session_name` | `name` | `set_session_name` |
| `new_session` | – | `new_session`; the hub re-keys and sends `opened` with `rekey` |
| `resnapshot` | – | full `snapshot` with `replace: true` |
| `copy` | – | `get_last_assistant_text`, answered with a `copy` frame |
| `set_model_query` / `set_thinking_query` | `query` | resolve against `get_available_models` / levels, then set |
| `abort` | – | `abort` |
| `earlier` | `before` (entry id) | hub reads the preceding window from the JSONL and replies with `history` |
| `stop` | – | detach process, keep JSONL |
| `ui` | `id`, `value` \| `confirmed` \| `cancelled` | `extension_ui_response` |

REST is only for discovery and process verbs: `GET /api/sessions`,
`POST /api/sessions`, `POST /api/sessions/:id/stop`, `GET /api/info`, `GET /health`
(`pid`, `startedAt`, `reloads`) and `POST /api/refresh` (loopback-only soft
refresh). Streaming never uses HTTP requests.

## Status line and session controls

The footer mirrors Pi's own footer component
(`dist/modes/interactive/components/footer.js`) rather than inventing a summary.
It sits **below** the composer (both inside the sticky `#dock`), so the command
menu and the queue own the space above the input:

- line 1: `~/cwd (branch) • session name`;
- line 2: `↑in ↓out R<cacheRead> W<cacheWrite> $cost` + `percent%/window (auto)`
  (warning above 70 %, error above 90 %), right-aligned `model • thinkingLevel`.

The hub sends **raw numbers** (`get_session_stats`, `get_state`, plus
`git -C cwd branch --show-current` cached per session) and the client formats, so
the rules live in one tested place (`src/client/footer.js`,
`test/footer.test.js`) and the hub stays a passthrough a Rust port can copy.

Model and thinking are plain RPC passthroughs (`get_available_models`,
`set_model`, `get_available_thinking_levels`, `set_thinking_level`); the footer is
the one place that shows and changes them. `thinking_level_changed` events keep it
in sync when the change happens elsewhere.

## Daemon lifecycle and refresh

`bin/pixip.ts` serves in the foreground by default; `start` spawns that same
entry detached with stdio to `<data-dir>/pixip.log` and polls `/health` until it
answers. One daemon per data dir: `pixip.pid` holds the pid, `pixip.state.json`
holds `{pid, host, port, url, startedAt, dataDir, args}` (args so `restart`
reproduces the configuration). `status`, `stop` and `refresh` read those files; a
dead pid is stale and gets cleaned rather than reported.

Soft refresh (`pixip refresh`, `SIGHUP`, `POST /api/refresh`) is the default and
must never disturb a turn:

1. re-resolve the command policy for every live session — two-phase, so a
   malformed file fails the refresh before any policy is swapped;
2. re-read `sessions.json` and drop the header cache;
3. swap the client asset map;
4. push the new `policy` frames and a fresh `sessions` frame to connected
   sockets.

Children and websockets are untouched; `/health` exposes `startedAt` and a
`reloads` counter so the CLI or the agent can verify it happened. The endpoint is
loopback-only (the UI has no auth) and answers
`{reloaded: ["assets", "config", "index", "commands"], reloads}`; the catalog is a
client asset, so `commands` rides on the asset re-read.

A hard restart is explicit: `pixip restart` refuses while a session is busy
unless `--force`, or waits for every session to be idle with `--when-idle`
(bounded by `--timeout`, default 300 s, exit 2 on timeout). The CLI stops the old
process (SIGTERM, then SIGKILL) and spawns the same serve args. Nothing is lost
that the JSONL does not already hold, and the client reconnects with backoff and
its durable cursor.

## Built-in slash commands

The classifier in `src/client/commands.js` marks the RPC-drivable TUI built-ins;
`src/client/app.js` keeps one handler per name and the hub is a thin wrapper:

- `/compact [instructions]` → `compact`; after `compaction_end` the client sends
  `resnapshot`, so the shrunken context replaces the loaded windows;
- `/name [name]` → toast the name, or `set_session_name` (the header follows the
  status frame);
- `/session` → local meta sheet from the snapshot `session` and the footer;
  no RPC, nothing added to the model context;
- `/copy` → `get_last_assistant_text`; `navigator.clipboard` with a sheet
  fallback for browsers without it;
- `/model [provider/model]`, `/thinking [level]` → the footer sheets, or a
  server-side resolve (exact provider/id, exact id, unique suffix / unique
  prefix) and a toast with the closest matches when unknown or ambiguous;
- `/new` → `new_session` in the same child; the hub mutates the live session in
  place (so the event closure survives), moves it to the new Pi id, appends the
  id to the index `piIds`, and sends `opened` with `rekey` to every tab, which
  then asks for a replacement snapshot;
- `/resume` → the session list; `/quit` → `stop` (detach) then the list.

Every handler is only reachable through the `00` classifier, so the per-session
policy and the TUI-only notices apply unchanged.

## Composer commands, `!`/`!!` and policy

The composer classifies a submitted line in one pure module
(`src/client/commands.js`, covered by `test/commands.test.js`):

- a name in the catalog is a pixip built-in (`02-builtin-commands`) or TUI-only
  (local notice, never sent to the model);
- any other `/…` line — extension commands like `/fit`, templates, skills,
  unknown names — is forwarded verbatim to `prompt`, exactly like the TUI;
- `!cmd` / `!!cmd` run through RPC `bash`, with `excludeFromContext` set for
  `!!`. The client paints the card optimistically and supplies its own id on the
  `bash` frame; Pi repeats that id on every `bash_execution_update` (forwarded
  verbatim as `event`) and the hub's final `bash` frame carries output, exit
  code, cancellation, truncation and the full-output path. `!`/`!!` with no
  command is a no-op, and only one bash runs per session at a time;
- plain text keeps `prompt` when idle and `steer` while busy. Slash input while
  busy uses `prompt` with `streamingBehavior: "steer"`, because RPC `steer`
  queues text and never executes an extension command.

`prompt` and `bash` are exempt from the 20 s RPC response timeout (extension
handlers block on user dialogs; a build can run for minutes), and a late or
failed prompt response is advisory — logged, never an error toast.

Policy is per session and restrict-only: `<data-dir>/pixip.json`,
`<cwd>/.pixip.json` and the CLI flags (`--allow-command`, `--deny-command`,
`--no-bash`) merge in `resolvePolicy()` (the same client module the hub imports),
and the hub serves the result as a `policy` frame on the session socket. Denied
and TUI-only commands produce a local notice and are never sent to the model.

## Measured latency (this box, 1 vCPU)

`tmp/smoke.mjs` against a local daemon, one prompt, `deepseek-v4.1-flash`:

| step | time |
|---|---|
| attach/spawn → `get_state` (Pi cold start) | **1.3 s** |
| attach → snapshot (8 entries) | +23 ms |
| prompt sent → `agent_start` | **6 ms** |
| prompt sent → user `message_end` echoed | **18 ms** |
| prompt sent → first `text_delta` | 1539 ms (model/provider, not hub) |
| `stop` (graceful detach) | **46 ms** |
| reattach after stop (cold) | 1.25 s |
| open (app loaded) → provisional snapshot frame, 17 MB session | **110–140 ms** |
| open (app loaded) → transcript painted, 17 MB session | **143–185 ms** |
| "load earlier" (200 entries from the JSONL, 17 MB session) | 54–77 ms |
| cold page load (browser, empty session) → transcript painted | ~230 ms |
| cold page load (browser, 200-entry window) → transcript painted | ~430–550 ms |

The provisional rows are measured with a local daemon and a synthetic 17 MB
session (1,900 entries, some 400 KB tool outputs): socket timing via the
`wsdump`-style probe, paint via `puppeteer-core` on the loaded session list
(tap → transcript painted), which is how the phone opens a session. The cold
page-load row is a full browser navigation on this 1 vCPU box; roughly 170–240 ms
of it is the app's own HTML/CSS/JS load, before the hub sees a socket. The first
paint only lays out the newest ~24 KB of the window; the rest of the 200 entries
fills in above in chunks (32 KB per task) without moving the scroll position.

So hub overhead is single-digit milliseconds; the perceived cost is Pi process
startup and provider latency. Budgets to keep:

- prompt → `agent_start` under 15 ms local;
- open a stopped session → readable transcript under 300 ms (app already loaded;
  the child boot continues behind the provisional window);
- event → frame emitted in the same tick (no queueing, no batching server-side);
- event → DOM paint within one rAF;
- no request per keystroke, no polling, no server-side transcript re-sends.

Startup cost is hidden rather than removed: the JSONL provisional window paints
first, and the child's 1.3 s boot no longer blocks the transcript. A warm pool is
still the way to make the child itself fast, and is deliberately not done (1 vCPU,
2 GB).

## UI strategy (responsiveness on a phone)

- append-only DOM for live events; deltas buffered and flushed in one rAF
  (`textContent += …`), never a full re-render per delta;
- snapshot only on connect/reconnect: one `innerHTML` for the newest slice, then
  older chunks prepended in tasks (24 KB first paint, 32 KB per chunk);
- collapsed `<details>` for thinking and tool output (the expensive text stays
  unparsed until opened… incoming tool output is still ANSI-converted once on end);
- `#log` is the only scroll container; sticky composer; `dvh` units; safe-area insets;
- optimistic user block on send, replaced by Pi's own echo when it arrives;
- text input 16 px so iOS does not zoom; Enter sends on fine pointers, newline on
  coarse ones (Shift+Enter always newlines).

## Memory policy

- Idle detach: `agent_settled` (or a fresh attach that is already idle) starts a
  timer; on expiry the child is closed and its JSONL kept.
- Reattach is on demand: opening the session re-spawns with `--session <file>`.
- No server-side transcript buffering; one socket per client; no fan-out copies.
- Measured: hub 92 MB RSS with one live child on this box (Node baseline is most
  of it).

## Rust port map

The split exists so this is mechanical:

| here | Rust |
|---|---|
| `src/rpc.ts` | `tokio::process::Child` + `tokio_util::codec::LinesCodec` (LF only, strip `\r`), `HashMap<Id, oneshot::Sender<Response>>`; do **not** use a Unicode-aware line reader |
| `src/hub.ts` | `HashMap<SessionId, Session>` behind one `mpsc` command loop; `SessionState` as an enum; `tokio::time::sleep` for idle |
| `src/wire.ts` | `#[serde(tag = "t")]` enums; event passthrough with `RawValue` |
| `src/server.ts` | `axum` router + `axum::extract::ws`; `include_bytes!` for the static client |
| `src/client/*` | unchanged (static assets) |
| tests | `cargo test` for framing/frames; the same JS tests keep guarding the client |

Rules that keep the port cheap: no dynamic dispatch in the protocol layer, no
Node-specific APIs beyond `child_process`/`http`, explicit state enum, one writer
per child, and raw bytes/strings on the hot path.

## Open design questions

1. Cold attach is 1.3 s. Warm pool of one idle child per cwd? The JSONL
   provisional paint hides it today; the pool would remove it.
2. Hub restart kills live children. Resume-all-on-start (by last activity) or
   leave them stopped?
3. Worktrees: pixip needs them to replace AoE; `git worktree` in the hub, or shell
   out to `aoe`-style helpers?
4. Ordering: snapshot + live events have a small race window; a durable cursor
   (`get_entries?since=<leafId>`) on reconnect closes it properly.
5. Multi-client: today each socket is independent; two phones on one session both
   get full streams (fine) but neither sees the other's optimistic input.

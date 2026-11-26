# Architecture

Goal: a supervisor plus a browser client for `pi --mode rpc`, small enough to
port to Rust without redesign, and fast enough that the UI never feels like a
remote terminal.

## Invariants

1. **No PTY, no terminal emulation.** The unit of data is Pi's structured record
   (message, delta, tool execution, UI request), never a byte stream of screen
   cells. This is what removes tmux-shaped impedance.
2. **Events are never re-encoded.** `src/rpc.ts` parses a line to correlate
   responses, then hands the _original string_ to the hub. The hub splices it into
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
   the socket). Blocking UI requests (`select`, `confirm`, `input`, `editor`,
   and `panel` when the host backend is active) are cached on the live session
   and replayed to a reattaching client before its snapshot. Timeout is owned
   by the hub, not by A2UI or the extension: a request waits 5 hours with no
   browser attached and 10 hours while one is attached
   (`--pending-ui-timeout-ms` / `--pending-ui-open-timeout-ms`, `0` disables).
   On timeout the hub sends `cancelled: true`, asks the agent whether the
   request should be offered again on resume, waits 60 seconds for a YES/NO
   (default yes), and records the raw request under
   `<data-dir>/pending-ui/<logical-id>.json`. Reopening the session shows a
   read-only re-ask card; the button prompts the agent to issue the same call
   again. The client renders active requests in a collapsible inline surface
   between `#log` and the composer, not as a modal: history stays scrollable,
   the composer is hidden while any blocking request is up, and a second
   pending request is queued behind a Replace banner. App-owned sheets stay
   modal.
6. **Isolation for development.** `--data-dir` sets `--session-dir`; nothing in
   `~/.pi/agent/sessions` is read or written by tests.

## Live thinking

Pi streams reasoning as `message_update` records whose `assistantMessageEvent`
is `thinking_start`, `thinking_delta`, or `thinking_end`. The client shows the
usual `agent is thinking…` marker until text arrives, then turns the marker into
a disclosure that streams the thought with the same ANSI rendering as the final
box. Tapping it toggles; if it is open at `message_end`, the final single
`details.think` box for that assistant message starts open. A message with no
thinking text keeps the plain, non-clickable marker.

The hub keeps one volatile buffer per attached session for the current assistant
message (`src/liveThinking.ts`): aggregate text by content block, capped at
256 KB newest-first, cleared at `message_end`, `tool_execution_start`, and
`agent_settled`, and never written to disk. The hot path still forwards the
original Pi record; only attach reads this buffer. After the snapshot the server
sends one derived `live_thinking` frame so a reloaded page can restore the
in-progress thought collapsed; a same-tab reconnect keeps its open choice.
Thinking events carry a monotonic sequence so buffered deltas already folded into
the derived frame are not appended twice. Completed thoughts are not replayed:
they come from the normal transcript snapshot.

## Inline panel surface and A2UI

The inline surface is a dedicated slot between the transcript and the composer,
not a modal and not part of the append-only transcript. It is expanded by
default, collapses to its header, keeps `#log` as the only scroll container,
queues a second blocking request behind a Replace banner, and is replayed from
the hub's pending-UI cache when a client reattaches. Only unanswered requests
replay; answered panels are dropped. Timed-out requests are stored separately
and appear as re-ask cards, never as a live Pi dialog. The composer is hidden
for every blocking method and an unsent draft is preserved; a submit while the
surface is up is refused. A2UI panels hide an in-panel `Text` node that repeats
the surface header title.

`src/client/panelHost.js` is the transport boundary. A renderer registers with
`registerPanelRenderer({ modes, mount })`; `mount(payload, api)` returns
`{snapshot, restore, destroy}`, and the host owns the frame, collapse, draft
`sessionStorage` (keyed by request id) and the fallback card. With no renderer,
or a payload that throws, the user sees a visible fallback instead of a blank
surface.

A2UI panels use `mode: "a2ui"` and an opaque payload
`{messages, surfaceId?, title?, mode}`. `messages` is the ordered A2UI v1.0
array; the surface id comes from the payload or the `createSurface` message. The
hub never parses A2UI: it forwards the payload and returns whatever action the
client sends.

`src/client/a2ui.js` is the only module that knows the renderer. It lazily
imports `src/client/vendor/a2ui.esm.js` on the first A2UI panel, so page load
never fetches it; the asset is 486 KB minified (~136 KB gzip) and committed with
its license and rebuild note beside it (`vendor/a2ui.README.md`, Apache-2.0).
The bundle pins `@a2ui/web_core` and `@a2ui/lit` 0.15.0, protocol `1.0`, Basic
catalog (`@a2ui/web_core/catalogs/basic/v1`); `tools/build-a2ui.mjs` rebuilds it
with a pinned `npx esbuild`, and CI only reads the committed output. Component
types are checked against the catalog before mounting, and unknown types or
processor errors produce the fallback card.

The action sent back is a JSON string with `name`, `surfaceId`,
`sourceComponentId`, `timestamp`, and a `context` whose `@path` bindings are
resolved from the data model, or `{cancelled: true}` for an explicit cancel. The
extension parses it; the hub treats it like any other `extension_ui_response`.

A2UI is data, not code: only catalog components render, strings are never
injected as HTML, media URLs go through the catalog's sanitizer, and custom
catalogs or model-generated surfaces are out of scope. Completed surfaces are
not written to session history; only a pending panel replays from the hub's
cache.

## Embedded host boundary

`pi-host/` contains `pixip-pi-host`, an optional package that embeds the Pi SDK
and speaks Pi RPC v1 plus a `hello` record and a blocking `panel` UI request.
It exists so an integration can stop spawning `pi --mode rpc` without patching
Pi. The host emits protocol records on stdout only, shares the user's Pi agent
dir and extension set for now, and is isolated by its own `--session-dir`.

It is opt-in: `--pi-host [path]` (or `PIXIP_PI_HOST`) makes the hub spawn the
host for new and reattached sessions; `--pi` remains the default. The host is
resolved from the installed workspace package when the flag has no value, and
there is no silent fallback to a global `pi`. `hello` is consumed by the hub for
diagnostics and never forwarded as a transcript event; `panel` joins
`select`/`confirm`/`input`/`editor` in the pending-UI cache and replay path.
Automatic titles use the host's `--print` one-shot mode when the host backend is
active. The hub remains the only process that owns the browser protocol.

Every Pi-speaking child is spawned through `src/spawnEnv.ts`: it copies the
inherited environment, drops `PI_SESSION_ID` and `PI_SESSION_FILE` (which
describe whichever Pi session started or restarted the daemon), and then applies
per-child values such as `PIXIP_SESSION_ID`. Pi fills in its own session
variables for its own shell tools, so no child starts with another session's
identity; config, provider auth, PATH and proxy variables pass through untouched.
The CLI restart helper and `startDaemon` use the same helper, so a daemon started
from inside a Pi session is clean as well.

Measured on this box (2026-11-21, Node 22.23.5, real Pi 1.5.2 vs workspace host,
three cold/warm attaches per backend):

| metric                         | legacy `pi --mode rpc` | `pixip-pi-host` | delta  |
| ------------------------------ | ---------------------- | --------------- | ------ |
| cold attach (create)           | 1239 ms                | 3745 ms         | +202%  |
| warm attach (reattach)         | 1240-1331 ms           | 3487-3657 ms    | ~+180% |
| child RSS                      | 108-110 MB             | 149-152 MB      | ~+37%  |
| command round-trip (get_state) | 1.55 ms                | 1.59 ms         | ~equal |
| event -> frame, median / p95   | 0.30 / 1.71 ms         | 0.30 / 1.30 ms  | ~equal |

The host is slower to boot because it loads the SDK and the user's extension set
in-process; once attached, command and event latency match the legacy child.
That is why the host stays opt-in until boot cost is addressed.

## Data flow

```
 phone browser                    hub (pixip)                     pi child
 ─────────────                    ───────────                     ─────────
 open /ws?session=<id> ──────▶  window()
                                  ├─ read JSONL tail ───────────┐ (200 entries or
                                  │                             ▼  256 KB, text capped)
 bytes ◀─ bounded window ────────┤
                                  ├─ spawn pi --mode rpc ───────▶  process
                                  ├─ get_state           ───────▶  session id
                                  └─ get_entries since=<leaf> ◀───  delta
 bytes ◀───── resume delta ──────┤
                                  │  stdout line (raw)  ◀────────  event
 bytes ◀── {"t":"event","ev":…} ──┤  (no parse/re-encode)
 {"t":"prompt","text":…} ───────▶ ┤─ prompt              ───────▶  command
                                                                    │
 {"t":"ui","id":…,"value":…} ───▶ ┤─ extension_ui_response ──────▶  ctx.ui
```

One child process per _attached_ session. `--idle-ms` detaches it; the list still
shows the session as `stopped` from the JSONL header, and opening it reattaches.

Opening a session is a two-step paint. The hub reads the JSONL tail **before**
spawning (`src/hub.ts` `window()`): up to the last 200 entries, reading backwards
until ~256 KB of raw line bytes, whichever bound comes first, with each entry's
text truncated to 8 KB and marked `truncated: true`. That snapshot goes out with
`state: "stopped"` mapped to `starting`, so the transcript is readable while the
child boots; a live green/yellow session keeps its real `idle`/`busy` state, so
the composer is usable immediately. When the child answers, the hub asks Pi only
for `get_entries since=<JSONL leaf>` and sends that delta as a `resume` snapshot.
Pi's full history is never requested: on an 11 MB session that call took 4.6 s and
an 8.4 MB frame, while the bounded window is tens of milliseconds.

A reconnect that carries a durable cursor skips the JSONL window entirely and
requests only the delta. Resume deltas are capped and marked the same way. Older
history comes from the JSONL through `earlier` windows of 200 entries.

Switching away from a live green/yellow session **parks** its socket instead of
closing it. The client keeps keyed connections: the session-less dashboard key
stays separate, and the active session plus up to two parked sessions
(`PARKED_LIMIT = 2` in `src/client/transport.js`) are live WebSockets. `park`
removes that socket's session subscription and list watcher but keeps the
WebSocket and its rekey listener; no event, list, status, footer or policy frame
reaches a parked socket. `resume {since}` replays policy and addon frames,
re-subscribes (which also replays unanswered UI requests), requests
`snapshot(since=<lastEntryId>)` through the same buffer/coverage path used by
attach, then sends footer and commands. A parked socket that dies is evicted
silently: only the active socket owns the reconnect/backoff path. A `/new` in
another tab still reaches a parked socket as `opened` with `rekey`; the client
closes it, drops the cache entry, and activation reconnects normally. Returning
repaints the cached transcript synchronously and sends `resume` on the warm
socket, so the network cost is one round trip plus the delta rather than a
WebSocket handshake. The client
keeps windows the user already loaded, dedupes by entry id and holds
`scrollHeight - scrollTop` constant so a prepend never moves the view. Expanding
a truncated block asks for that one full entry (`entry` frame), read backwards
from the JSONL in growing bounded chunks; entries not yet flushed by a live turn
keep their capped text and can be retried after the turn settles.

Transient states are explicit: `starting` (child booting, provisional paint),
`busy` (agent running), `idle`, `stopped` (JSONL only), `error` (child died).

A stopped session keeps its name: the disk scan reads the JSONL header (first
line) plus `session_info` records from the first ~20 lines and from a bounded
16 KB tail, so a rename late in the session still shows. Header and name share
one mtime-cached entry per file; no whole-file read is needed to list.

## Wire protocol v1

All frames are JSON text on one websocket. `v` is bumped on breaking change.

Hub → client:

| frame      | fields                                                                                                             | notes                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`    | `v`, `sessions`, `defaultCwd`, `home`                                                                              | sent on a session-less socket                                                                                                                                                                |
| `sessions` | `sessions`                                                                                                         | list refresh                                                                                                                                                                                 |
| `snapshot` | `session`, `entries`, `leafId`, `more`, `resume?`, `replace?`                                                      | (re)places the window; `more` = older entries exist, so "load earlier" is offered; `resume` means append only the cursor delta; `replace` drops windows loaded before a compaction or `/new` |
| `entry`    | `id`, `entry` \| `error`                                                                                           | answer to a lazy full-text request; `entry` is `null` with a reason when the JSONL does not have it yet                                                                                      |
| `history`  | `entries`, `more`                                                                                                  | answer to `earlier`: the window just before the oldest held entry                                                                                                                            |
| `status`   | `session`                                                                                                          | state/name/model changes                                                                                                                                                                     |
| `event`    | `ev`                                                                                                               | **verbatim** Pi record                                                                                                                                                                       |
| `opened`   | `session`, `rekey?`                                                                                                | reply to `create`; `rekey` when `/new` moved the session to a new Pi id                                                                                                                      |
| `copy`     | `text`                                                                                                             | answer to a `copy` frame: Pi's last assistant text (`null` if none)                                                                                                                          |
| `policy`   | `policy` (`allow`, `deny`, `bash`)                                                                                 | effective per-session command policy                                                                                                                                                         |
| `commands` | `commands` (`name`, `description?`, `source`)                                                                      | live `get_commands` entries for the `/` menu; sent once per attach, cached by the client                                                                                                     |
| `queue`    | `steering`, `followUp`                                                                                             | answer to `clear_queue`: the texts Pi removed, restored into the composer unsent                                                                                                             |
| `tree`     | `tree`, `leafId`                                                                                                   | answer to `/tree`: Pi's read-only session tree                                                                                                                                               |
| `fork`     | `text`, `cancelled`                                                                                                | answer to `/fork`; the new session itself arrives as `opened` with `rekey`                                                                                                                   |
| `clone`    | `cancelled`                                                                                                        | answer to `/clone`; same re-key path                                                                                                                                                         |
| `import`   | `cancelled`                                                                                                        | answer to `/import`; the switched-to session arrives as `opened`                                                                                                                             |
| `export`   | `html`, `jsonl`                                                                                                    | download URLs served by the export REST route (`jsonl` is `null` when Pi has no file yet)                                                                                                    |
| `bash`     | `id`, `command`, `excludeFromContext`, `output`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath?`, `error?` | terminal result for `!`/`!!`; chunks arrive as `event`                                                                                                                                       |
| `error`    | `message`                                                                                                          | protocol/command failure                                                                                                                                                                     |

Client → hub:

| frame                                    | fields                                      | maps to                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create`                                 | `cwd`, `name?`                              | spawn a new session                                                                                                                                          |
| `prompt`                                 | `text`, `streamingBehavior?`                | `prompt` (`"steer"` while busy: extension commands must still execute)                                                                                       |
| `steer`                                  | `text`                                      | `prompt` with `streamingBehavior: "steer"` (RPC `steer` only queues, so an idle steer would never run); the chips follow Pi's verbatim `queue_update` events |
| `clear_queue`                            | –                                           | `clear_queue`; answered with a `queue` frame carrying the restored texts                                                                                     |
| `tree`                                   | –                                           | `get_tree`, answered with a `tree` frame                                                                                                                     |
| `fork`                                   | `entryId`                                   | `fork`; the hub re-reads `get_state`, re-keys and the socket sends `opened` with `rekey`                                                                     |
| `clone`                                  | –                                           | `clone`; same re-key path                                                                                                                                    |
| `import`                                 | `path`                                      | copy a JSONL into `<data-dir>/sessions/`, `switch_session`, re-key                                                                                           |
| `export`                                 | –                                           | `export_html` under `<data-dir>/exports/`, answered with download URLs                                                                                       |
| `bash`                                   | `id`, `command`, `excludeFromContext`       | `bash`; `id` is repeated on streamed updates and the final frame                                                                                             |
| `compact`                                | `instructions?`                             | `compact` (`customInstructions`)                                                                                                                             |
| `set_session_name`                       | `name`                                      | `set_session_name`                                                                                                                                           |
| `new_session`                            | –                                           | `new_session`; the hub re-keys and sends `opened` with `rekey`                                                                                               |
| `park`                                   | –                                           | keep the WebSocket open, remove the session subscription and list watcher; the socket stays eligible for `resume`                                            |
| `resume`                                 | `since` (entry id, optional)                | re-subscribe, replay policy/addon/pending UI, then send a `resume` snapshot with the cursor delta; footer and commands follow                                |
| `resnapshot`                             | –                                           | full `snapshot` with `replace: true`                                                                                                                         |
| `copy`                                   | –                                           | `get_last_assistant_text`, answered with a `copy` frame                                                                                                      |
| `set_model_query` / `set_thinking_query` | `query`                                     | resolve against `get_available_models` / levels, then set                                                                                                    |
| `abort`                                  | –                                           | `abort`                                                                                                                                                      |
| `earlier`                                | `before` (entry id)                         | hub reads the preceding window from the JSONL and replies with `history`                                                                                     |
| `entry`                                  | `id` (entry id)                             | hub reads that one full entry from the JSONL and replies with `entry`, or an error while it is not on disk                                                   |
| `stop`                                   | –                                           | detach process, keep JSONL                                                                                                                                   |
| `ui`                                     | `id`, `value` \| `confirmed` \| `cancelled` | `extension_ui_response`                                                                                                                                      |

REST is only for discovery, process verbs and downloads: `GET /api/sessions`,
`POST /api/sessions`, `GET /api/dirs?path=`, `POST /api/dirs`,
`POST /api/sessions/:id/stop`,
`POST /api/sessions/:id/archive`, `POST /api/sessions/archive-inactive`,
`DELETE /api/sessions/:id`, `GET /api/archived`, `POST /api/archived/:id/restore`,
`DELETE /api/archived/:id`, `GET /api/trash`, `POST /api/trash/:id/restore`,
`DELETE /api/trash/:id`, `GET /api/worktrees?cwd=`, `DELETE /api/worktrees`
(JSON `{cwd, worktree: {branch}, force?}`),
`GET /api/sessions/:id/export.html` and `GET /api/sessions/:id/export.jsonl`
(both `Content-Disposition: attachment`), `GET /api/info`, `GET /health`
(`pid`, `startedAt`, `reloads`) and `POST /api/refresh`. Refresh is loopback-only;
the worktree routes follow the server bind like the rest of the dashboard, because
managing a tree is a normal session action rather than a host-local admin verb.
Streaming never uses HTTP requests.

## New-session directory picker

The dashboard's `browse` action fills the new-session path field from a bottom
sheet; it never creates a session itself. Listing is a discovery REST call
(`GET /api/dirs?path=`), so the hot websocket path is untouched.

Browsing is fenced to `$HOME`: `src/dirs.ts` resolves both the requested path
and home with `realpath`, refuses anything outside, and hides symlinks whose
target escapes. Dot-directories and files are never listed. A child with a
`.git` entry is a repo root and sorts first with a badge; the rest are
case-insensitive alphabetical. `POST /api/dirs` creates one visible path
segment under the current directory (`mkdir`, no `-p`) and rejects traversal,
collisions and names starting with a dot. Paths are absolute or `~`-relative;
relative input is resolved against home.

## Worktrees, repo groups and peers

A worktree is a parallel working directory, never a sandbox: agents share the
user, network and filesystem. Isolation is the administrator's container or VPS,
not a property of the tree. `src/worktree.ts` shells out to git and stays the
only git boundary; the hub adds `repo` (main repository root) to sessions in any
git repo and `worktree` (`{repo, path, branch, pixipActive}`) only for linked
worktrees. Both are persisted in the session index, so stopped rows keep their
group after a restart. `pixipActive` means pixip created the tree or mounted a
session in it; it is not a security boundary.

New trees live at `<repo-parent>/pixip_worktrees/<repo-name>/<slug>`, created
from the main repo's current `HEAD` (or an explicit base) with branch
`pixip/<slug>`. The slug is the directory name and is validated before any git
mutation. Joining an existing tree never runs `worktree add`: the hub detects a
linked worktree from the session cwd and inherits its metadata, so a manually
opened path joins the right group. A non-repo worktree request fails with git's
message and creates no session.

The dashboard groups sessions as one parent per repository with direct
main-repo rows and one child per worktree. A manually opened worktree row
synthesizes its parent from `worktree.repo`. `+` opens an anchored menu: a repo
parent offers `new` and `new with worktree`, a worktree child offers `new` (same
directory, no git mutation) and `delete`. The top new-session form has both
buttons; `new with worktree` fetches `GET /api/worktrees` first, then shows an
editable slug with the resulting directory and `pixip/<slug>` branch.

Delete is explicit and never automatic: stop, archive and session delete leave
the tree alone. `DELETE /api/worktrees` refuses a tree referenced by any listed
session (returning those sessions for its actions), refuses `pixipActive: false`
trees even with `force`, and requires `force` for a dirty tree after showing the
changed-file count. The main worktree is never removable. The CLI applies the
same rules (`pixip worktree remove <path> [--force]`), except that `--force`
only overrides dirty state: references and external trees always refuse.

The CLI keeps git logic in `src/worktree.ts` rather than duplicating commands:

- `pixip worktree list [<path>] [--json]` resolves the repository, lists every
  tree with owner (`pixip`/`external`), live agent count, dirty count and session
  names. With a running data-dir daemon it fetches `GET /api/worktrees` plus
  `GET /api/sessions`; offline it instantiates the `Hub` with startup trash
  cleanup disabled and calls the same list functions.
- `pixip worktree remove <path>` requires the exact worktree root, resolves the
  repo and delegates to the hub remove path (REST when a daemon is running,
  otherwise the offline Hub). Safe refusals exit `2`; usage/git/daemon errors exit
  `1`.
- `pixip worktree prune [<path>]` resolves the repo and runs `git worktree prune`
  through `src/worktree.ts`, printing the pruned repository. Prune only clears git
  admin records for trees whose directories disappeared; it never deletes a live
  worktree and is not part of normal session teardown.

Peers are a directory property: live sessions are compared by realpath cwd and
each `SessionInfo` carries reciprocal `peers: [{id, name}]`, refreshed on
create/stop/archive/child-exit. The client shows one inline transcript banner per
open session naming every peer, with a tap to open one and a dismiss that lasts
for that session. A changed peer set does not resurrect a dismissed banner.
Sharing one directory means agents can overwrite each other's files.

## Instant new-session window

Every dashboard new-session affordance (the `new` form button, `new with
worktree`, and a group's `+`)
does not wait for the child. It pushes a synthetic `#new` route, paints the
session shell with `starting session…` in the history and a disabled composer,
then sends the existing `create` frame on the dashboard socket. When the hub
answers `opened`, the client replaces the URL with the real
session id and opens a normal session socket; a failed create paints the error
and a back action instead of a dead id. The `#new` route only survives while the
create is in flight: a reload falls back to the dashboard. No protocol or hub
change is involved, and `/new` inside a session keeps its current behaviour.

## Archive, trash and session deletion

Archive and delete are file moves, not in-memory flags: the active scan only
looks at `<data-dir>/sessions`, so an archived session cannot reappear through a
restart. One logical session owns every JSONL in its index `piIds`; moving it
moves all of them plus its `sessions.json` record.

- **archive** → `<data-dir>/archive/<logical-id>-<random>/`: the JSONL files and
  a `meta.json` recording each file's original path. It stays until restored or
  permanently deleted from the settings archive sheet.
- **delete** → the same layout under `<data-dir>/trash`. The client confirms,
  shows a ~10 s undo toast, and the hub purges the directory after 60 s
  (`trashGraceMs`); startup empties any leftover trash from a previous process.
- **restore** moves the files back to their original paths, adding
  `.restored-N` only when a path is now occupied, then re-inserts the index
  record. Identity, name and cwd are preserved.
- **bulk archive** takes stopped sessions across all groups and continues on
  per-session failures. A group with no active session keeps its newest stopped
  session, so archiving cannot make that cwd group disappear. Busy/starting
  sessions are refused; idle ones are stopped first for a single action. A live
  session that is archived or deleted from another tab disappears from the
  `sessions` frame, and that tab returns to the dashboard with a toast.

The settings sheet reads the archive/trash metadata and offers restore and
permanent delete. Nothing enters the transcript or the model context.

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
(bounded by `--timeout`, default 300 s, exit 2 on timeout).

The stop/start itself runs in a **detached helper** (`restart --detached`, stdio
to `<data-dir>/pixip.log`), not in the CLI process. This is what makes a restart
issued from inside a pixip session work: a bash tool is a child of the Pi child
the old daemon is about to stop, so the foreground CLI dies with its session.
The helper is in its own session (`setsid` + `unref`), survives that shutdown,
waits for the old pid to exit, and starts the same serve args. `PIXIP_INSIDE=1`
and `PIXIP_SESSION_ID` are exported to every Pi child, so the CLI knows it is
inside a session: `--when-idle` ignores the calling session (it is the one being
replaced) and `pixip stop` from inside is turned into a forced restart instead of
taking the service down. A shell outside pixip still stops for real.

Nothing is lost that the JSONL does not already hold, and the client reconnects
with backoff and its durable cursor.

A restart is announced before it happens. The helper stops the old daemon with
`SIGUSR2` instead of `SIGTERM`; the daemon's handler broadcasts a
`{"t":"restarting"}` frame to every live session socket, gives it ~50 ms to
flush, and then closes. The browser shows `restarting…`, disables the composer,
and keeps its durable entry cursor. If a turn was streaming when the frame
arrived, the first reconnect snapshot appends a local (non-transcript) notice
saying the turn was interrupted; it is never sent to Pi or persisted. The new
daemon reattaches the same logical session on reconnect (spawning it from the
JSONL or the index record), so the URL and transcript anchor stay stable.
Unexpected daemon crashes have no frame; the same socket-close reconnect path
still applies, without claiming a planned restart.

## Built-in slash commands

The classifier in `src/client/commands.js` marks the RPC-drivable TUI built-ins;
`src/client/app.js` keeps one handler per name and the hub is a thin wrapper:

- `/compact [instructions]` → `compact`; while Pi compacts, the client shows a
  persistent `compacting context (<reason>)… Ns` row and locks the composer
  (the draft stays). A successful `compaction_end` sends `resnapshot`, which
  keeps the full history and paints a collapsed boundary with the summary,
  tokens before/after when known, duration and time. Aborted or failed
  compactions add no boundary and only toast the outcome. Automatic
  threshold/overflow compaction takes the same path and refreshes the footer;
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
- `/tree` → RPC `get_tree`, rendered as a read-only sheet (nesting indentation,
  branch labels, current-branch mark, fork/copy actions on user messages); no
  navigate command exists, so in-place leaf switching stays TUI-only;
- `/fork [entryId]` → RPC `fork`, also reachable from the small `fork`
  affordance on a snapshot user block; `/clone` → RPC `clone`. Both reuse the
  `/new` re-key path (re-read `get_state`, move the live map entry, append
  `piIds`, `opened` + resnapshot); cancellation is a toast;
- `/import <path>` → copy the JSONL into `<data-dir>/sessions/` (header id/cwd
  untouched, source never modified), index it as its own logical session, then
  `switch_session` and re-key;
- `/export` → `export_html` writes under `<data-dir>/exports/`; the `export`
  frame carries download URLs for the HTML and the session's own JSONL, both
  served as attachments;
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
- plain text is `prompt` when idle and `prompt` with `streamingBehavior: "steer"`
  while busy. Both the slash and the plain-text path deliberately avoid RPC
  `steer`: it only queues, so an idle steer would never start a turn (and RPC
  `steer` also never executes an extension command). `streamingBehavior` is
  additive — Pi ignores it when idle and starts a normal turn.

`prompt` and `bash` are exempt from the 20 s RPC response timeout (extension
handlers block on user dialogs; a build can run for minutes), and a late or
failed prompt response is advisory — logged, never an error toast.

Policy is per session and restrict-only: `<data-dir>/pixip.json`,
`<cwd>/.pixip.json` and the CLI flags (`--allow-command`, `--deny-command`,
`--no-bash`) merge in `resolvePolicy()` (the same client module the hub imports),
and the hub serves the result as a `policy` frame on the session socket. Denied
and TUI-only commands produce a local notice and are never sent to the model.

## Attachments

One attachment may be pending in the composer at a time: an image or an
arbitrary file. The `+` menu opens an image picker (`accept="image/*"`, no
`capture`, so the phone offers camera or library) or a generic file picker;
clipboard paste uses the same paths. Picking another attachment replaces the
pending one.

Images are decoded in the browser, downscaled to at most 1600 px on the longest
edge, and encoded as JPEG (PNG fallback). The base64 `ImageContent` rides the
existing WebSocket `prompt`/`steer` frame, exactly as Pi's RPC expects, and the
hub independently rejects anything not PNG/JPEG/GIF/WebP, over 8 MB decoded or
over ~11 MB base64. Pi normalizes and persists the image in the session JSONL;
a reload renders the recorded user-message image as a thumbnail that opens a
larger sheet, with no re-upload.

Non-image files never travel through the websocket. The client POSTs raw bytes
to `/api/sessions/<id>/uploads?name=<filename>` (100 MB cap), and the hub writes
`<data-dir>/uploads/<logical-session>/<uuid>-<safe-name>`. The prompt text gets
`Attached file: <absolute path>` after the typed text (or as the whole prompt for
an attachment-only send), so the agent can read, copy or move the file. Uploads
survive stop and reattach, and are cleared on `/new`, archive and delete.

A pending attachment blocks builtin commands and `!`/`!!` with an inline notice;
plain prompts and passthrough extension commands carry it. While Pi is busy the
image rides the same `prompt` + `streamingBehavior: "steer"` path, so a steer
never silently drops it.

## Agent-shown images

`extensions/pixip-show-image` registers `show_image_to_user({ path, caption? })`.
It is a separate tool on purpose: pixip renders image blocks only for this tool,
so an incidental image in a `read` or other tool result stays text. The path must
be absolute and names one PNG/JPEG/GIF/WebP file. Up to 1 MB the image is
returned unchanged; over 1 MB (to 20 MB) the extension returns a thumbnail
(longest edge 1024 px, at most 512 KB) and says the original is over the limit;
over 20 MB, or when no thumbnail can be made, it returns a link only. Pi's own
tool-result image normalization still runs after the tool returns.

The tool result carries `details: { path, caption?, bytes, thumbnail,
overSourceLimit, tooLarge }`. The client renders the first image as a visible
strip on the tool card with the text output folded below it; tapping opens the
same sheet as a user image. Snapshot, live `tool_execution_end` and the lazy
full-entry path use the same `toolResultParts()` rules. The tool's text keeps a
`file://` link for other hosts; in pixip the client rewrites it to
`GET /api/sessions/<id>/files?path=<absolute>` so the browser can download the
original. That route streams one regular image file (magic-byte checked,
`Content-Disposition: attachment`, 100 MB cap) and refuses relative paths.

## First-prompt session labels

A new session with no messages and no name gets a label from its first user
prompt. When that prompt is a slash command, the hub waits for the expanded user
message Pi actually runs (an extension command such as `/fit work` sends one
itself) and labels that text, so the alias is never mistaken for the task. The
hub starts a separate short-lived `pi --print --no-session` child
with tools, extensions, skills, prompt templates, context files and MCP disabled,
then applies the reply with `set_session_name`. The real session's transcript and
model context are untouched, and the call runs beside the prompt rather than on
its path.

Labels are normalized to sentence case, 3-5 words and 40 characters. The title
prompt ignores slash-command process boilerplate (board paths, review/commit
steps, tool names) and asks for the concrete feature, bug or decision, so a
`/fit work` session is named for its ticket rather than for the command. Ticket
ids and revisions remain useful context when they help identify the task. The
model is the session's current model; `--title-model` / `PIXIP_TITLE_MODEL`
overrides it. A failed, slow or empty call falls back to an explicit `title:`
field when the prompt has one, otherwise to its first meaningful words. A
configured override that no longer resolves falls back to the session model.

`sessions.json` records `nameSource: "auto" | "manual"`. Any name already present
at first prompt skips labeling, and a manual rename always wins; the automatic
label is never applied over a name that appeared while the one-shot call ran.

## Measured latency (this box, 1 vCPU)

`tmp/smoke.mjs` against a local daemon, one prompt, `deepseek-v4.1-flash`:

| step                                                            | time                              |
| --------------------------------------------------------------- | --------------------------------- |
| attach/spawn → `get_state` (Pi cold start)                      | **1.3 s**                         |
| attach → snapshot (8 entries)                                   | +23 ms                            |
| prompt sent → `agent_start`                                     | **6 ms**                          |
| prompt sent → user `message_end` echoed                         | **18 ms**                         |
| prompt sent → first `text_delta`                                | 1539 ms (model/provider, not hub) |
| `stop` (graceful detach)                                        | **46 ms**                         |
| reattach after stop (cold spawn)                                | ~1.3 s                            |
| reconnect → bounded JSONL window (11 MB / 1,200 entries)        | **8–45 ms**                       |
| switch green/yellow → window + resume delta                     | **7–43 ms**                       |
| reconnect with durable cursor → delta                           | **5–24 ms**                       |
| park/resume on one warm socket → delta (loopback)               | **~3 ms**                         |
| create → composer ready, alone                                  | **0.94–1.05 s**                   |
| create → composer ready, another agent busy streaming           | **1.28 s**                        |
| "load earlier" (200 entries from the JSONL, 17 MB session)      | 54–77 ms                          |
| cold page load (browser, empty session) → transcript painted    | ~230 ms                           |
| cold page load (browser, 200-entry window) → transcript painted | ~430–550 ms                       |

The owner's phone over cell measured HTTP RTT median **123 ms** (p95 266, max 490) and a WebSocket handshake median **239 ms**, against a loopback baseline of
4.7 ms and 13.6 ms. Park/resume removes the handshake from a switch-away/back, so
that return is roughly one RTT plus the delta instead of a handshake plus the
window.

The reconnect/create rows are from `tools/reconnect-bench.mjs` on an 11 MB
synthetic session, median of five socket runs against a local daemon with a real
`pi` child. The bench also measures `park`/`resume` on one socket and a browser
switch-away/back when Chromium is available. Before the bounded window, the authoritative `get_entries` call took
4.6 s warm / 7.2 s cold and produced an 8.4 MB frame. The browser paint rows are
older measurements from a synthetic 17 MB session; the bench measures paint too
when `PIXIP_CHROME` is set, but the CI box in this checkout had no Chromium
dependencies, so the current paint number was not re-taken here. The first paint
only lays out the newest ~24 KB of the window; the rest fills in above in chunks
(32 KB per task) without moving the scroll position.

So hub overhead is single-digit milliseconds; the perceived cost is now Pi
process startup, provider latency and the browser's own load. Budgets to keep:

- prompt → `agent_start` under 15 ms local;
- switch/reconnect green/yellow → readable transcript under 250 ms target,
  500 ms acceptable (browser paint, app already loaded);
- open a stopped session → readable transcript under 300 ms (the child boot
  continues behind the bounded window);
- create a session → usable composer under 1.5 s;
- event → frame emitted in the same tick (no queueing, no batching server-side);
- event → DOM paint within one rAF;
- no request per keystroke, no polling, no server-side transcript re-sends.

Startup cost is hidden rather than removed: the JSONL bounded window paints
first, and the child's 1.3 s boot no longer blocks the transcript. A warm pool is
still the only way to make the child itself fast, and is deliberately not done
(1 vCPU, 2 GB); reconnect no longer depends on it.

## UI strategy (responsiveness on a phone)

- dashboard sessions are grouped hierarchically by repository and worktree
  (`src/client/sessionGroups.js`, pure and unit-tested). A parent repo group
  counts all descendants and owns direct rows plus child worktree cards; plain
  directories stay flat. A collapsed group keeps every hot (`busy`/`starting`)
  or warm (`idle`) direct session plus its newest direct session visible, and
  hides its worktree children. Collapse state and the pinning toggle are
  device-local (`localStorage`), and group paths are shortened with `home` from
  `/api/info`/`hello`;
- each group header carries the git branch for its cwd. The hub resolves it once
  per distinct cwd on the session-list path (`git rev-parse --abbrev-ref HEAD`,
  cached ~5 s) and sends `branch` on the session info; subdirectories, worktrees
  and submodules show the enclosing repo, detached HEAD shows the short SHA, and
  a non-repo cwd has no chip. It is dashboard state only: nothing is added to the
  streaming path or the transcript;

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
- No server-side transcript buffering; one socket per route (dashboard plus
  active/parked sessions); no fan-out copies.
- Measured: hub 92 MB RSS with one live child on this box (Node baseline is most
  of it).

## Module map

The hub and client are split along the same seams a Rust port needs, so the
protocol path is still one obvious place to start:

| module                                                                      | owns                                                                                                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/backend.ts`                                                            | the spawn seam; the default backend creates `pi --mode rpc`, and `pixip-pi-host` can replace it without changing hub state |
| `src/rpc.ts`                                                                | LF framing, response correlation, original-record passthrough                                                              |
| `src/hub.ts`                                                                | public `Hub` facade and shared state; one method per operation                                                             |
| `src/hubLive.ts`                                                            | one child: spawn, records/events, pending UI timers, footer, idle detach                                                   |
| `src/hubStore.ts`                                                           | `sessions.json`, JSONL disk scan, archive/trash store, restore                                                             |
| `src/hubControl.ts`                                                         | snapshot/history, prompt/steer, queue/bash, policy, soft refresh                                                           |
| `src/hubSession.ts`                                                         | model/thinking/name, tree/fork/clone/import, `/new` re-key, UI replay                                                      |
| `src/jsonl.ts`                                                              | pure parse/window/truncate/coverage helpers (unit-tested)                                                                  |
| `src/sessionIndex.ts`                                                       | index/archive/trash record shapes and normalization                                                                        |
| `src/worktree.ts` / `src/hubWorktree.ts`                                    | the git boundary (detect/create/list/remove/dirty/merged) and hub list/remove safety rules                                 |
| `src/wire.ts`                                                               | the frame constructors; the protocol table above is authoritative                                                          |
| `src/client/app.js`                                                         | composition root: boot, DOM listeners, transport/navigation wiring; imports all features and exports nothing               |
| `src/client/frames.js`                                                      | protocol adapter: one frame switch, routed to feature handlers, plus socket-close reconnect                                |
| `src/client/navigation.js`                                                  | explicit route/navigation intents (`openSession`, `showList`, session cache helpers) installed by the composition root     |
| `src/client/kernel/state.js`                                                | the one flat shared state container; slices are connection, dashboard, session, composer, addon/panel                      |
| `src/client/kernel/ui.js`                                                   | the `$` helper and static element map for the shell in `index.html`                                                        |
| `src/client/{sheetShell,clipboard,sendState}.js`                            | small seams: modal shell primitives, clipboard helpers, composer send-state selectors                                      |
| `src/client/dashboard.js`                                                   | dashboard surface: list shell, archive/delete actions, settings entry                                                      |
| `src/client/dashboardApi.js`                                                | dashboard HTTP surface: sessions, archives, directories, uploads                                                           |
| `src/client/dashboardList.js`                                               | dashboard session list and cwd groups                                                                                      |
| `src/client/dashboardPicker.js`                                             | directory picker sheet transitions and DOM                                                                                 |
| `src/client/dashboardSettings.js`                                           | settings, archive and trash sheets                                                                                         |
| `src/client/dashboardModel.js`                                              | pure dashboard view model (no DOM, HTTP or kernel state)                                                                   |
| `src/client/dashboardWorktree.js`                                           | worktree create confirm and manage/delete sheet, including refusal states                                                  |
| `src/client/session.js`                                                     | open/cache/restore and the new-session shell                                                                               |
| `src/client/sessionEffects.js`                                              | snapshot/restart/status/re-key/socket-close frame effects                                                                  |
| `src/client/sessionPlan.js`                                                 | pure frame-effect plans used by `session.js` and `sessionEffects.js`                                                       |
| `src/client/transcript.js`                                                  | snapshot/windows, live events, footer, thinking state                                                                      |
| `src/client/sheets.js`                                                      | app-owned modal sheets (settings/model/tree/export/directory/notices) and `notify` routing                                 |
| `src/client/surface.js`                                                     | inline blocking-request surface: queue, collapse, Replace banner, answer/cancel                                            |
| `src/client/surfaceQueue.js`                                                | DOM-free active/queued request queue used by `surface.js`                                                                  |
| `src/client/panelHost.js`                                                   | generic `panel` renderer registry, fallback card, draft snapshot/restore in `sessionStorage`                               |
| `src/client/a2ui.js`                                                        | A2UI adapter: lazy bundle import, v1.0 lifecycle, action JSON, fallback and draft hooks                                    |
| `src/client/vendor/a2ui.esm.js`                                             | prebuilt A2UI v1.0 Lit renderer + Basic catalog, lazy-loaded; license and rebuild note beside it                           |
| `src/client/composer.js`                                                    | composer orchestration, built-in commands                                                                                  |
| `src/client/composerAttachments.js`                                         | attachment choose/render/prepare/upload lifecycle                                                                          |
| `src/client/composerBash.js`                                                | optimistic bash cards plus the hub's authoritative result                                                                  |
| `src/client/scroll.js`                                                      | shared transcript scroll seam: the only writer of the `#log` reading position                                              |
| `src/client/menuView.js`                                                    | command-menu visibility seam shared by composer/session/dashboard                                                          |
| `src/client/composerInput.js`                                               | composer field clear/resize primitives shared by composer and bash                                                         |
| `src/client/queueView.js`                                                   | queue-chip rendering shared by dashboard/session/menu/transcript                                                           |
| `src/client/transcriptView.js`                                              | append-only transcript DOM primitives other features may use                                                               |
| `src/client/sessionView.js`                                                 | header/status/footer chrome and the busy indicator                                                                         |
| `src/client/configure.js`                                                   | `installDeps` for the per-module `configureX({ ...callbacks })` boundaries                                                 |
| `src/client/{addonUi,transcriptScale,transcriptScroll,transcriptWindow}.js` | addon status/widget cache, transcript text scale, pure scroll math, window planning                                        |
| `src/client/{directoryPicker,sessionCache,sessionInfo,sessionGroups}.js`    | pure path math, session cache persistence, session info, cwd grouping                                                      |
| `src/client/{markdown,render,attachments,commands,tree,footer}.js`          | pure/markup helpers: markdown, HTML painting, attachment encoding, command catalog, session tree, footer formatting        |     | `src/client/{menu,controls,toast,transport}.js` | menus/queue, scale/refresh controls, notices, keyed websocket manager with park/resume |
| `tools/check-client-imports.mjs`                                            | client import-graph guard: cycles, `app.js` imports and feature-cluster boundaries                                         |
| `tools/browser-check.mjs`                                                   | scripted client flows at 390x844 and 1280x900 against an in-process fixture Hub                                            |
| `tools/shot.mjs` / `tools/build-a2ui.mjs`                                   | screenshot/layout probe, and the pinned A2UI bundle rebuild                                                                |

CSS is split into `base`, `transcript`, `list`, `status`, `composer`, `sheets` and
`surface` files loaded in that order: one asset set, no bundler and no
per-breakpoint markup. The hub modules are intentionally thin over the same shared state; the
public `Hub` API and the wire protocol are unchanged by that split.

The client keeps one state container in `kernel/state.js`. Its keys are grouped
into five documented slices — connection, dashboard, session, composer, and
addon/panel — but the object is deliberately flat, with no reactive framework
and no per-feature stores. `kernel/ui.js` owns the single element map; feature
modules import state or UI nodes from the kernel instead of re-querying the DOM
or reaching into `app.js`.

`src/client/app.js` is the only composition root: it imports the features,
installs their `configureX({ ...callbacks })` boundaries, wires transport and
navigation, then boots. `frames.js` is the only protocol adapter: it may import
feature handlers because it routes each hub frame to them, and features never
import it. Everyone else — including other features — talks to a feature through
the callbacks its `configureX` function accepts; there is no global ports
object, no service locator and no event bus. Shared code moves down into a
module both sides import (kernel, pure helpers, and the `scroll`, `menuView`,
`composerInput`, `queueView`, `transcriptView` and `sessionView` seams) rather
than becoming another callback.

The feature clusters are dashboard (`dashboard`, `dashboardApi`,
`dashboardList`, `dashboardPicker`, `dashboardSettings`, `dashboardModel`,
`dashboardWorktree`),
session (`session`, `sessionEffects`, `sessionPlan`) and composer (`composer`,
`composerAttachments`, `composerBash`). Allowed edges: features may import
kernel, pure/domain helpers, shared seams, and same-cluster siblings; they must
not import another cluster. Only `app.js` and `frames.js` may import a feature
module at all. Nothing imports `app.js`, and the graph has no cycles.

`tools/check-client-imports.mjs` is the executable copy of that rule; the
cluster map lives in that file and nowhere else. `npm run check:imports` fails
on a cycle, an `app.js` import, a cross-cluster feature import, or a non-feature
module importing a feature handler. `tools/browser-check.mjs` is the runtime
counterpart: it drives the real client through dashboard, worktree create/delete
refusal, peer notice, composer, inline `select`, A2UI panel and transcript-window
flows at 390x844 and 1280x900, failing on page/console errors or horizontal
overflow.

## Rust port map

The split exists so this is mechanical:

| here            | Rust                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/rpc.ts`    | `tokio::process::Child` + `tokio_util::codec::LinesCodec` (LF only, strip `\r`), `HashMap<Id, oneshot::Sender<Response>>`; do **not** use a Unicode-aware line reader |
| `src/hub.ts`    | `HashMap<SessionId, Session>` behind one `mpsc` command loop; `SessionState` as an enum; `tokio::time::sleep` for idle                                                |
| `src/wire.ts`   | `#[serde(tag = "t")]` enums; event passthrough with `RawValue`                                                                                                        |
| `src/server.ts` | `axum` router + `axum::extract::ws`; `include_bytes!` for the static client                                                                                           |
| `src/client/*`  | unchanged (static assets)                                                                                                                                             |
| tests           | `cargo test` for framing/frames; the same JS tests keep guarding the client                                                                                           |

Rules that keep the port cheap: no dynamic dispatch in the protocol layer, no
Node-specific APIs beyond `child_process`/`http`, explicit state enum, one writer
per child, and raw bytes/strings on the hot path.

## Open design questions

1. Cold attach is 1.3 s. Warm pool of one idle child per cwd? The bounded JSONL
   window hides it for reads, but a create still waits for the child; the pool
   would remove that wait (see the Pi hot-swap spike in the ticket board).
2. Hub restart kills live children. Resume-all-on-start (by last activity) or
   leave them stopped?
3. Worktree create/list/remove/prune are implemented across the dashboard, REST
   and CLI; the remaining worktree gaps belong to the options TOML and desktop
   surface tickets, not the lifecycle.
4. Ordering: snapshot + live events have a small race window; a durable cursor
   (`get_entries?since=<leafId>`) on reconnect closes it properly.
5. Multi-client: today each socket is independent; two phones on one session both
   get full streams (fine) but neither sees the other's optimistic input.

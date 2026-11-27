# Host protocol and boundary

The product is three processes in a line: a browser, a hub, and one Pi-speaking child per attached session. The browser only ever sees the hub's JSON wire protocol; the hub only ever sees Pi RPC records and the session JSONL. This area inventories that contract — what crosses each boundary, which guarantees the UI depends on, and which parts a rewrite may replace without changing behaviour.

## Contents

- [User stories](#user-stories)
- [The shape behind the phone](#the-shape-behind-the-phone)
- [Protocol contract](#protocol-contract)
  - [Ownership and truth](#ownership-and-truth)
  - [The embedded Pi host](#the-embedded-pi-host)
  - [RPC v1 framing](#rpc-v1-framing)
  - [Wire protocol v1](#wire-protocol-v1)
  - [REST's narrow role](#rests-narrow-role)
  - [Opening a session and sending a prompt](#opening-a-session-and-sending-a-prompt)
  - [Reattach, window and cursor](#reattach-window-and-cursor)
  - [Extension panels and replay](#extension-panels-and-replay)
  - [Re-key and replacement windows](#re-key-and-replacement-windows)
  - [Guarantees and replaceable parts](#guarantees-and-replaceable-parts)
  - [Port map and latency budgets](#port-map-and-latency-budgets)
- [Wireframes](#wireframes)
- [Sources](#sources)
- [Boundaries and open items](#boundaries-and-open-items)

## User stories

- As a user, I want opening a session to paint readable history immediately and then catch up without missing entries.
- As a user, I want a pending question to survive a reconnect and still be answerable, including after a park/resume or a page reload.
- As an extension author, I want my unchanged Pi extension to keep working through the hub, including blocking dialogs and the pixip panel surface.
- As a user, I want `/new`, fork, clone and import to move me to the new transcript without leaving a stale window on screen.
- As a rewrite engineer, I want a precise list of frames, routes and guarantees so I can redesign the transport deliberately rather than guess at behaviour.

## The shape behind the phone

A browser holds zero session truth. It asks for one session's bounded transcript window, subscribes to that session's frames, and keeps whatever windows the user has loaded. The hub owns process state: which sessions are attached, which child serves each one, pending dialogs and the browser fan-out. Pi's JSONL file is the source of truth for conversation state; restart the hub, or detach an idle session, and `--session <file>` brings the transcript back.

That division is what makes the phone experience possible. A stopped session can paint from disk before any process exists, so opening it feels immediate even though a Pi child takes over a second to boot. A live session's events are forwarded as the original Pi records, so the browser renders the same message shapes Pi produced, not a lossy summary. Nothing server-side accumulates transcript history.

There is exactly one child per *attached* session, not one per session on disk. The dashboard lists stopped sessions from JSONL headers; attaching spawns the child, and `--idle-ms` detaches it again after a settled turn. One websocket exists per route: the session-less dashboard socket, plus the active session and up to two parked sessions on the client.

## Protocol contract

### Ownership and truth

| thing | owner | durable? |
| --- | --- | --- |
| conversation, transcript records | Pi JSONL under `<data-dir>/sessions` | yes |
| live child, pending dialogs, footer cache | hub (`src/hub.ts` and its modules) | no |
| loaded transcript windows, scroll position | browser | per page |
| session identity mapping (logical id ↔ Pi ids) | hub index `sessions.json` | yes |
| command policy, addon status/widgets | hub, replayed on attach | derived |

The hub never builds a conversation model. It reads a bounded tail of the JSONL for first paint, asks the child only for the delta after the JSONL leaf, and otherwise passes records through. This is the invariant to keep: no server-side transcript buffering and no event re-encoding.

### The embedded Pi host

`pi-host/` builds `pixip-pi-host`, the default child. It imports `@earendil-works/pi-coding-agent` in-process and speaks Pi RPC v1 on stdin/stdout, so pixip can stop spawning `pi --mode rpc` without patching or vendoring Pi. The legacy `pi --mode rpc` child remains available only through `--use-system-pi`, which requires an explicit `--pi` or `PIXIP_PI`; `PIXIP_PI_HOST` overrides the host executable. There is no silent fallback to a global `pi`.

Spawn arguments match the Pi CLI for the flags pixip uses: `--mode rpc` (accepted and ignored), `--session-dir <p>`, `--session <p>`, and `--name <p>`. `process.cwd()` is the session cwd. Unknown arguments fail on stderr and exit non-zero without writing a partial protocol line. The host also has a one-shot `--print` mode used for automatic session titles.

The host adds two things to stock Pi RPC:

- **`hello`** — the first stdout record: `{type:"hello", protocol:1, piVersion, capabilities:["panel","reload"]}`. The hub consumes it for diagnostics and never forwards it as a transcript event.
- **`panel`** — a blocking extension UI request with an opaque JSON payload. It joins `select`/`confirm`/`input`/`editor` in the same pending-UI and replay path.

The host shares the user's Pi agent directory — settings, auth, models, skills, prompt templates and extension set — and installs the same built-in MCP, codemode and tool-search factories with the same replacement flags as the Pi CLI. `--session-dir` is the isolation boundary for development and tests. The host speaks only to the hub: it adds no server, no auth and no client surface.

The backend choice does not change hub state or the wire protocol. It changes only the spawn seam (`src/backend.ts` → `src/rpc.ts`). A host child is also the one that can answer an in-place `reload` command; a system-pi child is respawned by the daemon instead.

### RPC v1 framing

RPC is LF-delimited JSON: one object per line, one optional trailing CR stripped, and only LF as a boundary. A Unicode-aware line reader is wrong here because U+2028 and U+2029 are legal inside JSON strings; `src/rpc.ts` splits on LF over a `StringDecoder` buffer instead.

Outbound commands carry a generated id (`c1`, `c2`, …) and the hub awaits the matching `response` record. Responses resolve or reject a pending promise by id. The default request timeout is 20 s. `prompt` and `bash` opt out (`timeoutMs: 0`) because an extension handler may block on a user dialog and a build may run for minutes; a late prompt response is advisory and never an error toast. Child exit rejects every pending command immediately, and a spawn error reports exit once so startup cannot hang.

Each parsed line also goes to the hub callback *as the original string*. The hub splices that string into `{"t":"event","ev":<raw>}`. It does not rebuild the value tree on the hot path. This is both the latency budget and the port boundary: Rust uses `RawValue` and a lines codec with a response map.

### Wire protocol v1

One websocket carries JSON text frames. `WIRE_VERSION` is `1` and `v` appears on `hello` and `sessions`; it is bumped only on a breaking change. Additive optional fields do not bump it, and a client that does not know a frame ignores it.

Hub → client:

| frame | fields | purpose | kind |
| --- | --- | --- | --- |
| `hello` | `v`, `sessions`, `defaultCwd`, `home` | first frame on a session-less socket | stream start |
| `sessions` | `sessions` | dashboard list refresh | stream |
| `snapshot` | `session`, `entries`, `leafId`, `more`, `resume?`, `replace?` | place or append the transcript window | stream / answer |
| `entry` | `id`, `entry` or `error` | one lazily expanded full entry | answer |
| `history` | `entries`, `more` | older window answering `earlier` | answer |
| `status` | `session` | state, name or model changed | stream |
| `event` | `ev` | **verbatim** Pi record | stream |
| `opened` | `session`, `rekey?` | reply to `create`; re-key notice | answer / stream |
| `copy` | `text` | Pi's last assistant text, `null` if none | answer |
| `policy` | `policy` (`allow`, `deny`, `bash`) | effective command policy for this session | stream on attach |
| `commands` | `commands` (`name`, `description?`, `source`) | live `/` menu entries | stream on attach |
| `queue` | `steering`, `followUp` | texts removed by `clear_queue` | answer |
| `tree` | `tree`, `leafId` | read-only session tree | answer |
| `fork` | `text`, `cancelled` | fork result; the new session arrives as `opened` | answer |
| `clone` | `cancelled` | clone result; same re-key path | answer |
| `import` | `cancelled` | import result; switched session arrives as `opened` | answer |
| `export` | `html`, `jsonl` | download URLs, `jsonl` null when no file exists | answer |
| `bash` | `id`, `command`, `excludeFromContext`, `output`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath?`, `error?` | terminal `!`/`!!` result | stream end / answer |
| `footer` | `footer` | raw tokens, cost, context, model and thinking | stream |
| `models` | `models`, `current` | model picker contents | answer |
| `thinking` | `levels`, `current` | thinking-level picker contents | answer |
| `inbox` | `inbox` | unread count, cap state, newest summary | stream |
| `live_thinking` | `text`, `active` | derived in-progress thought restored on attach | stream on attach |
| `ui_need_time` | `id`, `method`, `title`, `timeoutMs` | ask whether to keep a dialog alive | stream |
| `panel_draft` | `id`, `draft` | restore a shelved panel draft | stream on attach |
| `ui_timeout` | `id` | drop the surface without answering it | stream |
| `reasks` | `requests` | timed-out dialogs offered as re-ask cards | stream on attach |
| `notice` | `text`, reload/restart/pause/watch fields | ephemeral local notice, never a Pi record | stream |
| `restarting` | — | old daemon is being replaced | stream |
| `error` | `message` | protocol or command failure | answer |

Client → hub:

| frame | fields | maps to |
| --- | --- | --- |
| `create` | `cwd`, `name?`, `worktree?` | spawn a new session |
| `stop` | — | detach the child, keep the JSONL |
| `reload` | `nonce`, `pause?` | daemon-wide asset/policy/code reload |
| `restart` | `nonce`, `force?`, `pause?` | replace the daemon process |
| `watch_cancel` | — | drop a deferred `--watch` reload |
| `pause_cancel` | `resume?` | cancel or resume a timed-out pause plan |
| `prompt` | `text`, `streamingBehavior?` | Pi `prompt` |
| `steer` | `text`, images | `prompt` with `streamingBehavior: "steer"` |
| `clear_queue` | — | Pi `clear_queue`, answered with `queue` |
| `bash` | `id`, `command`, `excludeFromContext` | Pi `bash`; id is repeated on streamed updates |
| `abort` | — | Pi `abort` |
| `entry` | `id` | read one full entry from the JSONL |
| `earlier` | `before` | read the preceding window from the JSONL |
| `models` / `thinking` | — | Pi `get_available_models` / levels |
| `set_model` / `set_thinking` | `provider`, `id` / `level` | set directly |
| `set_model_query` / `set_thinking_query` | `query` | resolve exact, then unique suffix/prefix, then set |
| `compact` | `instructions?` | Pi `compact` |
| `set_session_name` | `name` | Pi `set_session_name` |
| `new_session` | — | Pi `new_session`, then re-key |
| `copy` | — | Pi `get_last_assistant_text` |
| `tree` | — | Pi `get_tree` |
| `fork` | `entryId` | Pi `fork`, then re-key |
| `clone` | — | Pi `clone`, then re-key |
| `import` | `path` | copy JSONL into the session dir, `switch_session`, re-key |
| `export` | — | `export_html`, answer with download URLs |
| `resnapshot` | — | full snapshot with `replace: true` |
| `ui` | `id`, `value`/`confirmed`/`cancelled` | `extension_ui_response` |
| `ui_more_time` | `id`, `more`, `draft` | extend or shelve a pending dialog |
| `reask` | `id`, `action` | ask the agent to re-issue a timed-out dialog |
| `park` | — | keep the socket, drop the session subscription |
| `resume` | `since?` | re-subscribe and resume from the cursor |

Streaming frames are `event`, `status`, `sessions`, `footer`, `inbox`, `notice`, `restarting`, `policy`, `commands`, `live_thinking` and the pending-UI notices. Everything else is a direct answer to one client frame. `snapshot` is both: it is the attach response and the place where a streaming window is established.

### REST's narrow role

REST is for discovery, process verbs and downloads. It never carries streaming.

| route | purpose |
| --- | --- |
| `GET /health` | pid, startedAt, reloads, generation |
| `POST /api/refresh` | soft refresh of assets/policy/index |
| `GET /api/info` | daemon and home/cwd defaults |
| `GET /api/sessions` | session list |
| `POST /api/sessions` | create a session |
| `GET /api/dirs?path=`, `POST /api/dirs` | directory browse and create |
| `GET /api/worktrees?cwd=`, `DELETE /api/worktrees` | worktree discovery and removal |
| `POST /api/sessions/:id/stop` | detach |
| `POST /api/sessions/:id/archive`, `POST /api/sessions/archive-inactive` | archive one or many |
| `POST /api/sessions/:id/protect` | exclude from bulk archive |
| `DELETE /api/sessions/:id` | move to trash with an undo token |
| `GET /api/archived`, `POST /api/archived/:id/restore`, `DELETE /api/archived/:id` | archive sheet |
| `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/:id` | trash sheet |
| `POST /api/sessions/:id/uploads?name=` | raw non-image attachment upload |
| `GET /api/sessions/:id/files?path=` | one image download for `show_image_to_user` |
| `GET /api/sessions/:id/export.html`, `.jsonl` | attachment downloads |
| `GET /api/inbox`, `POST /api/inbox`, `POST /api/inbox/reports`, `POST /api/inbox/extension`, `POST /api/inbox/read-all` | inbox list, send, report attach, extension send, read-all |
| `POST /api/inbox/:id/read`, `/archive`, `/restore`, `DELETE /api/inbox/:id` | one-message verbs |
| `GET /reports/<name>/`, `/reports/<name>/<asset>` | sandboxed HTML reports |
| `GET /api/dev/panel-fixture` | dev-only A2UI fixture |

The UI itself is served as static assets; there is no bundler and no build step. Uploads are the one place binary data enters over HTTP rather than the websocket.

### Opening a session and sending a prompt

Opening is a two-step paint. On a session socket without a cursor, the hub reads the JSONL tail first: up to 200 entries or 256 KB of raw lines, whichever binds first, with each entry's text capped at 8 KB and marked truncated. It sends that as a `snapshot`, mapping a stopped session to `starting` so the UI does not flash a wake card; a live session keeps its real `idle`/`busy` state, so the composer is usable immediately.

Then the hub spawns (or reuses) the child, reads `get_state` for the Pi id, file, name, model, thinking level and message count, resolves policy, and sends it. It subscribes to the child before asking for entries and buffers keyed frames in the gap. The request is `get_entries since=<JSONL leaf>` — never the full history. When the answer arrives it is sent as a `snapshot` with `resume: true`; buffered frames are flushed, dropping any entry already covered by the snapshot. Thinking deltas below the derived `live_thinking` sequence are dropped; newer ones follow it. Finally the hub sends the pending-UI replay, footer and commands.

A prompt is a single passthrough. The browser sends `prompt` (idle) or `steer` (busy, mapped to `prompt` with `streamingBehavior: "steer"`). The hub issues the RPC command and forwards Pi's resulting `event` records verbatim. `agent_start` flips status to busy; `agent_settled` flips it back, refreshes the footer and schedules idle detach. The browser paints an optimistic user block and replaces it with Pi's own echo, so the protocol never needs a hub-invented "sent" record.

### Reattach, window and cursor

A reconnect with a durable `since` entry skips the JSONL window entirely and asks only for the delta. Without a cursor, the same two-step path runs again, but against an already-live child: the bounded window paints, then `get_entries since=<leaf>` catches up.

The hub's buffering is the no-gap guarantee. Every frame that carries an entry identity is buffered from subscribe until the snapshot is sent. Frames without identity (status, dialogs) go out immediately because order does not matter for them. If the buffer exceeds its frame or byte bound, the hub drops it and re-requests from the durable cursor instead of retaining an unbounded turn. The client dedupes by entry id.

Park/resume keeps one warm websocket. `park` removes the session subscription and list watcher but leaves the socket and its re-key listener. `resume {since}` replays policy and add-on frames, re-subscribes (which replays unanswered dialogs), requests `snapshot(since=<lastEntryId>)`, then footer and commands. A parked socket that dies is evicted silently; only the active socket owns reconnect/backoff.

Older history never comes from Pi. `earlier` reads the preceding 200-entry window from the JSONL in growing bounded reads; expanding one truncated block sends `entry` and the hub reads that one full entry (up to 8 MB) backwards from disk. Entries not yet flushed by a live turn may be unavailable; the client keeps the capped text and can retry after the turn settles.

### Extension panels and replay

A blocking extension dialog arrives as a normal Pi `extension_ui_request` record. The hub forwards it as an `event`, caches it on the live session, and starts a lifetime timer: 5 hours with no browser attached and 10 hours while one is attached (`--pending-ui-timeout-ms`, `--pending-ui-open-timeout-ms`, `0` disables). On attach, every unanswered request replays before the snapshot's history is usable, so a question survives a page reload.

The client renders it in the inline surface between transcript and composer, not as a modal. History stays scrollable, the composer is hidden, and a second blocking request queues behind a Replace banner. `ui` sends the answer back as `extension_ui_response`. A2UI panels are just a `panel` method with `mode: "a2ui"` and an opaque payload; the hub does not parse A2UI or any panel schema.

On timeout the hub sends a cancellation and asks the agent whether the request should be offered again, waiting 60 s for YES/NO (default yes). It records the raw request under `<data-dir>/pending-ui/<logical-id>.json`. Reopening shows a read-only re-ask card; `reask` asks the agent to issue the same call again. A live request or a recorded re-ask sets `awaitingUser`, which drives the header and dashboard dot.

### Re-key and replacement windows

`new_session`, `fork`, `clone` and `import` all change the Pi session id under a stable pixip logical id. After the RPC succeeds, the hub re-reads `get_state`, moves the live entry to the new id, appends the new id to the index, and notifies every tab through the socket's re-key listener. Each tab receives `opened` with `rekey: true`, drops its cached window and reconnects or requests `resnapshot`. `replace: true` tells the client to discard every window loaded before the change, so pre-compaction or pre-`/new` history never mixes with the replacement.

The old JSONL remains on disk and reachable from the dashboard. Re-keying is a live-map move, not a new child, so the event closure survives and no turn is lost.

### Guarantees and replaceable parts

Preserve these or the product changes:

- **Verbatim events.** `frameEvent` splices the original Pi record into one field. No parse-and-re-encode on the event path.
- **One scroll container and bounded windows.** History is read from the JSONL in bounded tails; Pi is never asked for the full transcript.
- **JSONL as truth.** A hub restart, stop or detach never requires an in-memory transcript to rebuild.
- **Cursor-based resume.** Reconnect is delta-first; the client dedupes and holds scroll position when a prepend arrives.
- **Pending-UI replay.** An unanswered blocking request must reappear on a new socket, in original order relative to the snapshot.
- **Re-key notification.** Every tab following a session must learn that its Pi id changed before it paints the replacement.
- **Backend seam.** The hub's state machine and wire frames do not depend on whether the child is the embedded host or system Pi.

Replaceable without changing behaviour:

- the embedded host implementation, as long as it speaks RPC v1 plus `hello` and `panel`;
- Node's module-generation reload machinery — a supervised restart may deliver the same user-visible contract;
- `src/rpc.ts` and the transport internals, as long as LF framing, response correlation and original-string passthrough remain;
- the client's renderer, as long as it consumes the same frames and keeps the same window/scroll contract.

### Port map and latency budgets

The module seams exist so a Rust port is mechanical:

| here | Rust shape |
| --- | --- |
| `src/rpc.ts` | child process + LF lines codec, response map to oneshot channels; no Unicode line reader |
| `src/hub.ts` | session map behind one command loop, explicit state enum, timer for idle |
| `src/wire.ts` | tagged enums; event passthrough as `RawValue` |
| `src/server.ts` | HTTP router plus websocket extractor; static assets embedded |
| `src/reload/*` | Node-only; replace with a supervised restart |
| `src/client/*` | unchanged static assets |

Budget constraints the new design must meet or consciously change: prompt → `agent_start` under 15 ms local; event → frame in the same tick; event → paint within one rAF; switch/reconnect green/yellow → readable transcript under 250 ms target and 500 ms acceptable; open a stopped session under 300 ms; create → usable composer under 1.5 s; no request per keystroke, no polling, no server-side transcript re-sends. Current measured hub overhead is single-digit milliseconds; the perceived cost is Pi startup, provider latency and browser load.

## Wireframes

### System context

```svg
<svg viewBox="0 0 760 340" width="100%" style="display:block;width:100%;max-width:760px;height:auto" role="img" aria-labelledby="wf90-context">
  <title id="wf90-context">Browser talks JSON frames to the hub; hub spawns one Pi host per attached session and reads Pi JSONL as the source of truth</title>
  <rect x="4" y="4" width="752" height="332" rx="14" fill="#16141f" stroke="#322b45"/>
  <rect x="24" y="48" width="170" height="232" rx="9" fill="#1d1a29" stroke="#7aa2f7"/>
  <text x="36" y="70" font-family="ui-monospace, monospace" font-size="11" fill="#e7e3f2">browser</text>
  <text x="36" y="90" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">windows · scroll · composer</text>
  <text x="36" y="108" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">panel surface · drafts</text>
  <text x="36" y="126" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">no conversation truth</text>
  <rect x="36" y="146" width="146" height="116" rx="7" fill="none" stroke="#322b45"/>
  <text x="48" y="166" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">session socket</text>
  <text x="48" y="184" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">park / resume</text>
  <text x="48" y="202" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">durable cursor</text>
  <text x="48" y="220" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">REST: verbs only</text>

  <rect x="278" y="48" width="214" height="232" rx="9" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="290" y="70" font-family="ui-monospace, monospace" font-size="11" fill="#e7e3f2">hub</text>
  <text x="290" y="90" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">process state · fan-out</text>
  <text x="290" y="108" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">spawn seam · RPC framing</text>
  <text x="290" y="126" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">bounded JSONL window</text>
  <text x="290" y="144" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">pending UI cache · re-key</text>
  <rect x="290" y="160" width="190" height="102" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="302" y="180" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">frames v1</text>
  <text x="302" y="198" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">event · snapshot · status</text>
  <text x="302" y="216" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">opened · policy · footer</text>
  <text x="302" y="234" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">verbatim ev, never parsed</text>

  <rect x="566" y="48" width="170" height="110" rx="9" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="578" y="70" font-family="ui-monospace, monospace" font-size="11" fill="#e7e3f2">pi host child</text>
  <text x="578" y="90" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">one per attached session</text>
  <text x="578" y="108" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">RPC v1 + hello + panel</text>
  <text x="578" y="126" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">user extensions untouched</text>
  <text x="578" y="144" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">system pi is opt-in</text>

  <rect x="566" y="184" width="170" height="96" rx="9" fill="#1d1a29" stroke="#e0af68"/>
  <text x="578" y="204" font-family="ui-monospace, monospace" font-size="11" fill="#e7e3f2">pi JSONL</text>
  <text x="578" y="224" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">source of truth</text>
  <text x="578" y="242" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">survives stop / restart</text>
  <text x="578" y="260" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">bounded tail on open</text>

  <line x1="194" y1="126" x2="278" y2="126" stroke="#7aa2f7"/>
  <text x="198" y="118" font-family="ui-monospace, monospace" font-size="8" fill="#7aa2f7">ws JSON</text>
  <line x1="492" y1="104" x2="566" y2="104" stroke="#9ece6a"/>
  <text x="498" y="96" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">LF JSON</text>
  <line x1="566" y1="236" x2="492" y2="220" stroke="#e0af68"/>
  <text x="500" y="252" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">read tail</text>
  <text x="266" y="306" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the hub is the only process that owns the browser protocol</text>
</svg>
```

### Open session and prompt

```svg
<svg viewBox="0 0 780 430" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-labelledby="wf90-open">
  <title id="wf90-open">Sequence: open paints a bounded JSONL window, spawns the child, then catches up from the leaf cursor; a prompt is forwarded and events stream back verbatim</title>
  <rect x="4" y="4" width="772" height="422" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="764" y="28" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">open → catch up → prompt</text>
  <text x="60" y="52" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">browser</text>
  <text x="270" y="52" font-family="ui-monospace, monospace" font-size="9" fill="#bb9af7">hub</text>
  <text x="470" y="52" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">JSONL</text>
  <text x="650" y="52" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">pi child</text>
  <line x1="60" y1="62" x2="60" y2="404" stroke="#322b45" stroke-dasharray="3 4"/>
  <line x1="290" y1="62" x2="290" y2="404" stroke="#322b45" stroke-dasharray="3 4"/>
  <line x1="490" y1="62" x2="490" y2="404" stroke="#322b45" stroke-dasharray="3 4"/>
  <line x1="670" y1="62" x2="670" y2="404" stroke="#322b45" stroke-dasharray="3 4"/>
  <line x1="60" y1="86" x2="290" y2="86" stroke="#7aa2f7"/>
  <text x="66" y="80" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">open /ws?session=…</text>
  <line x1="290" y1="112" x2="490" y2="112" stroke="#e0af68"/>
  <text x="296" y="106" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">tail: 200 entries / 256 KB</text>
  <line x1="290" y1="138" x2="60" y2="138" stroke="#bb9af7"/>
  <text x="66" y="132" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">snapshot · starting · more</text>
  <line x1="290" y1="166" x2="670" y2="166" stroke="#9ece6a"/>
  <text x="296" y="160" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">spawn + get_state</text>
  <line x1="670" y1="190" x2="290" y2="190" stroke="#9ece6a"/>
  <text x="296" y="184" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">id · file · name · model</text>
  <line x1="290" y1="216" x2="670" y2="216" stroke="#9ece6a"/>
  <text x="296" y="210" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">get_entries since=leaf</text>
  <line x1="290" y1="242" x2="60" y2="242" stroke="#bb9af7"/>
  <text x="66" y="236" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">snapshot resume · footer · commands</text>
  <line x1="60" y1="278" x2="290" y2="278" stroke="#7aa2f7"/>
  <text x="66" y="272" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">prompt text</text>
  <line x1="290" y1="304" x2="670" y2="304" stroke="#9ece6a"/>
  <text x="296" y="298" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">prompt command</text>
  <line x1="670" y1="330" x2="290" y2="330" stroke="#9ece6a"/>
  <text x="296" y="324" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">agent_start · message · deltas</text>
  <line x1="290" y1="356" x2="60" y2="356" stroke="#bb9af7"/>
  <text x="66" y="350" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">event {ev: raw}</text>
  <text x="66" y="386" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">same tick · no batching</text>
</svg>
```

### Panel, replay and reattach decision

```svg
<svg viewBox="0 0 780 420" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-labelledby="wf90-panel">
  <title id="wf90-panel">Panel request travels child to hub cache to surface; reconnect replays unanswered requests, else a cursor or a bounded window decides the catch-up path</title>
  <rect x="4" y="4" width="772" height="412" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">PANEL / REPLAY</text>
  <rect x="18" y="42" width="168" height="42" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">extension calls ctx.ui.panel</text>
  <text x="28" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">blocking · opaque payload</text>
  <line x1="186" y1="63" x2="214" y2="63" stroke="#6f6889"/>
  <rect x="214" y="42" width="168" height="42" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="224" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">extension_ui_request</text>
  <text x="224" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">stdout · verbatim event</text>
  <line x1="382" y1="63" x2="410" y2="63" stroke="#6f6889"/>
  <rect x="410" y="42" width="168" height="42" rx="7" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="420" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">hub pending-UI cache</text>
  <text x="420" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">5 h idle · 10 h attached</text>
  <line x1="578" y1="63" x2="606" y2="63" stroke="#6f6889"/>
  <rect x="606" y="42" width="156" height="42" rx="7" fill="#1d1a29" stroke="#7aa2f7"/>
  <text x="616" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">inline surface</text>
  <text x="616" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">answer / cancel / draft</text>
  <path d="M684 84 L684 104 L434 104 L434 86" fill="none" stroke="#7aa2f7"/>
  <text x="438" y="118" font-family="ui-monospace, monospace" font-size="8" fill="#7aa2f7">extension_ui_response</text>

  <text x="18" y="158" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">REATTACH DECISION</text>
  <rect x="18" y="174" width="128" height="42" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="192" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">socket opens</text>
  <text x="28" y="206" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">or park resume</text>
  <line x1="146" y1="195" x2="174" y2="195" stroke="#6f6889"/>
  <polygon points="204,170 246,195 204,220 162,195" fill="#241f33" stroke="#bb9af7"/>
  <text x="192" y="199" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">cursor?</text>
  <line x1="246" y1="195" x2="286" y2="195" stroke="#6f6889"/>
  <text x="250" y="188" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">yes</text>
  <rect x="286" y="174" width="166" height="42" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="296" y="192" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">get_entries since</text>
  <text x="296" y="206" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">delta only · no repaint</text>
  <line x1="204" y1="220" x2="204" y2="246" stroke="#6f6889"/>
  <text x="210" y="240" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">no</text>
  <rect x="140" y="246" width="166" height="42" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="150" y="264" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">bounded JSONL window</text>
  <text x="150" y="278" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">paint before spawn</text>
  <line x1="306" y1="267" x2="344" y2="267" stroke="#6f6889"/>
  <rect x="344" y="246" width="178" height="42" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="354" y="264" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">catch up from leaf</text>
  <text x="354" y="278" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">buffered events · dedupe</text>
  <line x1="204" y1="288" x2="204" y2="314" stroke="#6f6889"/>
  <rect x="140" y="314" width="166" height="42" rx="7" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="150" y="332" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">replay pending UI</text>
  <text x="150" y="346" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">then footer · commands</text>

  <text x="540" y="170" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">BACKEND</text>
  <rect x="540" y="184" width="108" height="34" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="548" y="205" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">host (default)</text>
  <rect x="540" y="228" width="108" height="34" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="548" y="249" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">--use-system-pi</text>
  <text x="658" y="198" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">SDK in-process</text>
  <text x="658" y="214" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">hello + panel</text>
  <text x="658" y="242" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">explicit --pi</text>
  <text x="658" y="258" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">no silent fallback</text>
  <text x="18" y="390" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">same frames and hub state for both backends; only the spawn seam changes</text>
</svg>
```

## Sources

`src/rpc.ts`, `src/wire.ts`, `src/server.ts`, `src/hub.ts`, `src/hubLive.ts`, `src/hubControl.ts`, `src/hubSession.ts`, `src/backend.ts`, `src/pendingReask.ts`, `src/liveThinking.ts`, `pi-host/README.md`, `pi-host/src/{main,args,protocol,runtime}.ts`, `ARCHITECTURE.md` (invariants, embedded host boundary, wire protocol, Rust port map, measured latency).

## Boundaries and open items

- RPC and wire framing are documented as contracts here, not as a promise that the current Node modules stay in place. The reload machinery is explicitly replaceable.
- The host shares the user's Pi agent directory; plugin and login isolation are later work, not part of this contract.
- Pre-existing concerns outside this area: cold attach remains ~1.3–3.7 s because the SDK and extension set load in-process (warm pool is deliberately not done); snapshot plus live events has a small race that the durable cursor and buffer dedupe close in practice; multi-client optimistic input is not shared between sockets.
- No port verdicts are recorded here. The measured numbers and budgets are constraints for whoever redesigns the transport, not a recommendation.

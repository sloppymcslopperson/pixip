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

## Wire protocol v1

All frames are JSON text on one websocket. `v` is bumped on breaking change.

Hub → client:

| frame | fields | notes |
|---|---|---|
| `hello` | `v`, `sessions`, `defaultCwd` | sent on a session-less socket |
| `sessions` | `sessions` | list refresh |
| `snapshot` | `session`, `entries`, `leafId` | replaces the transcript |
| `status` | `session` | state/name/model changes |
| `event` | `ev` | **verbatim** Pi record |
| `opened` | `session` | reply to `create` |
| `error` | `message` | protocol/command failure |

Client → hub:

| frame | fields | maps to |
|---|---|---|
| `create` | `cwd`, `name?` | spawn a new session |
| `prompt` / `steer` | `text` | `prompt` / `steer` |
| `abort` | – | `abort` |
| `stop` | – | detach process, keep JSONL |
| `ui` | `id`, `value` \| `confirmed` \| `cancelled` | `extension_ui_response` |

REST is only for discovery and process verbs: `GET /api/sessions`,
`POST /api/sessions`, `POST /api/sessions/:id/stop`, `GET /api/info`, `GET /health`.
Streaming never uses HTTP requests.

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

So hub overhead is single-digit milliseconds; the perceived cost is Pi process
startup and provider latency. Budgets to keep:

- prompt → `agent_start` under 15 ms local;
- event → frame emitted in the same tick (no queueing, no batching server-side);
- event → DOM paint within one rAF;
- no request per keystroke, no polling, no server-side transcript re-sends.

Startup cost is the obvious next win (pre-warmed idle child, or `--no-session`
probe + `--session` attach). Not done yet; it is a real 1.3 s on a cold attach.

## UI strategy (responsiveness on a phone)

- append-only DOM; deltas buffered and flushed in one rAF (`textContent += …`),
  never a full re-render of the transcript;
- snapshot only on connect/reconnect, and it replaces the log in one `DocumentFragment`;
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

1. Cold attach is 1.3 s. Warm pool of one idle child per cwd? Or accept it and
   paint the snapshot from the JSONL while the child boots?
2. Hub restart kills live children. Resume-all-on-start (by last activity) or
   leave them stopped?
3. Worktrees: pixip needs them to replace AoE; `git worktree` in the hub, or shell
   out to `aoe`-style helpers?
4. Ordering: snapshot + live events have a small race window; a durable cursor
   (`get_entries?since=<leafId>`) on reconnect closes it properly.
5. Multi-client: today each socket is independent; two phones on one session both
   get full streams (fine) but neither sees the other's optimistic input.

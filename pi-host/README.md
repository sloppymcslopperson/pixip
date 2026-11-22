# pixip-pi-host

An embedded [Pi](https://github.com/earendil-works/pi) RPC host for pixip.

The host imports `@earendil-works/pi-coding-agent` in-process and serves Pi's
RPC v1 protocol on stdin/stdout, so pixip can stop spawning `pi --mode rpc`
without patching or vendoring Pi. It adds one startup record and one blocking
extension UI method (`panel`) that stock Pi RPC does not have.

This package is a workspace member of the pixip repository. The root
`npm run check` includes it; the package can also be checked on its own from
this directory.

```bash
npm install                 # from the repository root
npm run check               # from pi-host/
npm run smoke               # real SDK, temp data dir, no model call
```

## Spawn arguments

The host accepts the arguments pixip already passes to `pi --mode rpc`:

| argument            | meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `--mode rpc`        | Accepted and ignored. Only RPC mode exists here.                                |
| `--session-dir <p>` | Session directory passed to Pi's `SessionManager`. Relative to `process.cwd()`. |
| `--session <p>`     | Resume one JSONL session file. Relative to `process.cwd()`.                     |
| `--name <p>`        | Set the session name at startup through `appendSessionInfo()`.                  |

`process.cwd()` is the session cwd, exactly as it is for the `pi` child today.
Without `--session`, the host creates a new session in `--session-dir` (or Pi's
default session directory). Unknown arguments are errors on stderr; the host
exits non-zero without writing a partial protocol line.

## Protocol

Framing is strict JSONL: one JSON object per LF, one optional trailing CR
stripped. Split only on LF — U+2028/U+2029 are legal inside JSON strings.

The host is Pi RPC v1 plus two additions:

### `hello`

The first stdout record is:

```json
{ "type": "hello", "protocol": 1, "piVersion": "1.5.2", "capabilities": ["panel"] }
```

`protocol` is an integer, `piVersion` is the SDK version in use, and
`capabilities` lists protocol features beyond Pi RPC v1. `panel` is currently
the only entry.

### `panel`

A blocking extension UI method with an opaque JSON payload:

```json
{
	"type": "extension_ui_request",
	"id": "8a8e…",
	"method": "panel",
	"payload": { "messages": [], "surfaceId": "main", "title": "Form", "mode": "sheet" },
	"timeout": 60000
}
```

The client answers with the existing `extension_ui_response` shape:

```json
{ "type": "extension_ui_response", "id": "8a8e…", "value": "{\"name\":\"submit\"}" }
{ "type": "extension_ui_response", "id": "8a8e…", "cancelled": true }
```

`value` is passed through verbatim: the host does not parse or validate A2UI or
any other panel schema. That belongs to the extension and the client. An
extension calls it as `ctx.ui.panel(payload, opts?)`; `AbortSignal` and
`timeout` resolve the call with `undefined`, like the other dialogs.

All other command, response, event and extension UI shapes are unchanged from
Pi RPC. The command surface covers `prompt`, `steer`, `follow_up`, `abort`,
`clear_queue`, `get_state`, `get_entries`, `get_tree`,
`get_last_assistant_text`, `get_session_stats`, `get_available_models`,
`set_model`, `cycle_model`, `get_available_thinking_levels`,
`set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`,
`set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`,
`abort_retry`, `bash`, `abort_bash`, `new_session`, `switch_session`, `fork`,
`clone`, `get_fork_messages`, `set_session_name`, `export_html`, `get_commands`,
plus `get_messages` and a clean `shutdown` that responds, disposes the runtime
and exits 0. Unknown commands get a normal unsuccessful response.

`message_update` events use Pi's RPC transform: cumulative `partial` snapshots
are stripped and `toolcall_start` carries `id`/`toolName`. Extension failures
are emitted as `extension_error` records. The host never writes logs to stdout.

## Shared Pi state

The host currently uses the user's default Pi agent directory: existing
settings, auth, models, skills, prompt templates and the configured extension
set. It does not create a second config directory, change login, or copy
`auth.json`/`models.json`. Plugin and login isolation are deliberately later
work.

Built-in extension factories for MCP, codemode and tool search are installed
with the same names and replacement flags as the Pi CLI, so a user extension can
still take over any of them. `--session-dir` is the test isolation boundary; the
smoke script passes a temporary directory and never touches the user's sessions.

## Boundary

The host speaks only to the pixip hub. The hub remains the only process that
owns the browser protocol; the host adds no server, no auth, and no client
surface. `src/protocol.ts` is the pure protocol loop (fake-runtime testable);
`src/runtime.ts` is the real SDK wiring.

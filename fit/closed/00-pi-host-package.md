---
project: pixip
grilled: true
commit: "8ad634a8d0451d44f8adb87b50d29f98b20ccbcd"
---

Build `pixip-pi-host`, a Node package that embeds the project-local `@earendil-works/pi-coding-agent` SDK and speaks Pi RPC v1 plus a small `hello`/`panel` extension, so pixip can stop spawning `pi --mode rpc` without patching or vendoring Pi. The host uses the user's existing Pi agent directory, settings, auth and plugins for now; plugin and login isolation are deliberately later.

### Package

- Create a new workspace package under `pi-host/` named `pixip-pi-host` with a `pixip-pi-host` bin. Pin its `@earendil-works/pi-coding-agent` dependency to the version pixip targets (start with 1.5.2) and commit the lockfile.
- Keep the package independently testable; pixip integration is a separate ticket.
- Do not add a second Pi config directory, change login, or copy `auth.json`/`models.json`. Use the default agent dir so the current login keeps working.

### Host protocol

- Read JSONL commands from stdin and write JSONL records to stdout, same framing as Pi RPC (LF-only; strip one trailing CR).
- Accept the existing spawn args `--mode rpc`, `--session-dir`, `--session`, `--name`; `--mode rpc` is accepted and ignored. Use `process.cwd()` as the session cwd.
- Emit one `hello` record at startup with `protocol`, `piVersion`, and `capabilities` (`panel` is the only new one).
- Keep Pi RPC command/response shapes and event shapes unchanged so the existing hub/client can consume them. Copy or reimplement Pi's `toJsonEvent` transformation: strip cumulative `partial` snapshots from `message_update`, add `id`/`toolName` on `toolcall_start`.
- Add one blocking UI request method, `panel`, carrying an opaque JSON `payload`; resolve it with `value` or `cancelled`.
- Handle `extension_ui_response` on stdin by id for all blocking requests.

### Host behavior

- Build the session with `createAgentSessionRuntime` and `createAgentSessionServices`; bind extensions with `uiContext` and `mode: "rpc"`.
- Provide the full extension UI context: `select`, `confirm`, `input`, `editor`, `panel`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and safe no-ops for TUI-only methods.
- Include built-in extension factories needed for CLI parity (at least MCP, codemode, tool-search) but do not change the user's configured extension set.
- Support the RPC command surface pixip uses: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `get_state`, `get_entries`, `get_tree`, `get_last_assistant_text`, `get_session_stats`, `get_available_models`, `set_model`, `cycle_model`, `get_available_thinking_levels`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `set_session_name`, `export_html`, `get_commands`, and a clean `shutdown`.
- Re-bind subscriptions and the UI context after `new_session`, `switch_session`, `fork` or import replaces the active session.
- On extension errors, emit `extension_error` records; never write logs to stdout.

### Acceptance

- Unit tests drive the protocol loop with an injected fake runtime/session: command routing, event serialization, UI request/response, cancellation, and shutdown.
- A real-SDK smoke script opens a new in-memory or data-dir session, reads `hello`, gets state/entries, and shuts down without calling a model provider.
- `npm run check` in the host package is green; the root `npm run check` includes it if the package is added as a workspace.
- A README documents the protocol delta (`hello`, `panel`), spawn arguments, and the fact that the host currently shares the user's Pi agent dir.
- No A2UI, questionnaire, or pixip client changes in this ticket.

### Notes

- Why this exists: Pi's RPC mode is a thin wrapper around the SDK, but it only exposes `select`/`confirm`/`input`/`editor`; a custom host can expose `panel` without an upstream Pi change.
- Measured on this box: cold import of the Pi SDK is ~3.1 s, creating a session after import ~0.32 s. If cold attach is a problem, a warm/multiplexed host can be a later ticket; do not solve it here.
- The hub must remain the only process that owns the browser protocol; the host speaks only to the hub.

### Decisions (grilled 2026-11-22)

- **SDK reuse:** clean reimplementation. Use only public `@earendil-works/pi-coding-agent` exports for the runtime, services, session and types. Write our own stdin loop, command handlers, UI context and extension error path. Do not copy `dist/modes/rpc/rpc-mode.js`; only the small `toJsonEvent` transform may be reimplemented/copied as the ticket allows. `runRpcMode` is not used because its UI context cannot expose `panel`.
- **Workspace:** add `"workspaces": ["pi-host"]` to the root `package.json` and keep a single root `package-lock.json`. Root `npm run check` includes the host's typecheck/lint/format/test.
- **Language/build:** TypeScript sources run directly by Node (type stripping, matching the root), `tsc --noEmit` for typecheck, no build step, bin points at the `.ts` entry.
- **`hello`:** first stdout record is `{"type":"hello","protocol":1,"piVersion":"<version>","capabilities":["panel"]}`; `protocol` is an integer.
- **`panel`:** opaque pass-through. Extension calls `ctx.ui.panel(payload, opts?)`; host emits `{"type":"extension_ui_request","id","method":"panel","payload", ...timeout?}` and forwards the raw response `value` or `cancelled`. The host never parses or validates A2UI; the A2UI schema belongs to the extension and the client ticket. Honour `AbortSignal`/`timeout` like the other dialogs and resolve `undefined` on cancel.
- **Extensions/settings:** mirror the Pi CLI. Use the default agent dir, the user's settings and extension set, and include the built-in MCP/codemode/tool-search factories the same way the CLI does. No second config dir, no auth/model copying.
- **Smoke:** `npm run smoke` is a separate documented script using a temp `--data-dir`; it is not part of `npm run check`. `check` stays hermetic with an injected fake runtime/session.
- **Demo extension:** none. `hello` and `panel` are protocol additions; tests use an injected fake extension/runtime. Do not ship a loadable sample extension.
- **Docs:** `pi-host/README.md` documents the protocol delta, spawn args and shared agent dir. Root `README.md` gets a short pointer; `ARCHITECTURE.md` gets a short host-boundary paragraph. No latency-number changes.
- **Scope:** only new `pi-host/` plus root workspace/lockfile/check wiring and the short root docs pointer. No `src/`, `bin/`, client, hub or A2UI changes.

### Verification

- `pi-host`: `npm run check` green (typecheck, lint, prettier, 15 protocol/args tests).
- `pi-host`: `npm run smoke` green against the real SDK 1.5.2 (hello, get_state, get_entries, shutdown, temp session dir).
- Root: `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` exit 0, including the host workspace check. The bare command fails only because this agent runs with `PIXIP_INSIDE=1`, which makes the pre-existing daemon lifecycle tests treat a normal stop as an inside restart; rerunning without that inherited variable is green.
- Work commit: `8ad634a FIT: close pi-host-package`.

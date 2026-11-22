---
project: pixip
grilled: true
commit: "609646f479119608a8a0cbb1ed2f4d479fb83999"
---

Wire pixip to use `pixip-pi-host` for new and reattached sessions behind an explicit option, keeping the existing `pi --mode rpc` child as the fallback. The goal is to prove protocol parity and the `panel` path before changing the default.

### Work

- Resolve the host package's bin from the pixip install or a `--pi-host <path>` / `PIXIP_PI_HOST` override; keep `--pi` for the legacy child.
- Add a backend switch in `src/hub.ts`/`src/rpc.ts` so the hub can spawn either the legacy Pi child or the host with the same `--session-dir`/`--session`/`--name` arguments and the same env.
- Consume the host's `hello` record to record capabilities; do not forward `hello` to the browser as a transcript event.
- Add `panel` to the hub's blocking-UI cache and replay path, so a pending panel survives reconnect exactly like `select`/`confirm`/`input`/`editor`.
- Keep the title/label child on the project-local Pi CLI, or give the host a `--print` path; do not silently fall back to a global `pi`.
- Add a test with a fake host that covers hello, prompt, event forwarding, panel request/replay/answer, and shutdown.
- Measure cold attach, warm attach, RSS and event latency against the legacy child on this box. Record the numbers in the ticket and `ARCHITECTURE.md`; make the host opt-in until the numbers are acceptable.

### Acceptance

- `node bin/pixip.ts --pi-host <host-bin>` runs a session through the host; the client transcript and composer behave as before.
- A pending `panel` request is replayed after reload and answered through the existing `ui` frame.
- Killing/restarting the host follows the existing session error/reattach path.
- Legacy `--pi` remains the default and its tests stay green.
- `npm run check` green; screenshots at 390/1280 only if the client changes.

### Out of scope

- Rendering A2UI (`02-a2ui-panel-renderer`), the questionnaire plugin (`03-pixip-questionnaire`), plugin/login isolation (backlog), and making the host the default.

### Decisions (grilled 2026-11-21)

- **Selection/resolution:** `--pi-host [path]` is opt-in. With no value it resolves the workspace/install `pixip-pi-host` bin (package `bin` entry); an explicit path wins. `PIXIP_PI_HOST` is the env fallback. Absent flag/env keeps legacy `--pi` as the default. A missing/unresolvable host fails loudly at startup, never falls back to a global `pi`.
- **Host args:** pass `--mode rpc --session-dir <dir> [--session <file>] [--name <name>]` and the same env as the legacy child. Existing `pi --mode rpc` tests remain the default.
- **Titles:** add a true one-shot `--print` mode to `pixip-pi-host` (no session file, no tools/extensions/skills/templates/context/MCP, thinking off, optional `--model`, prompt as the last arg, plain text on stdout, diagnostics on stderr). When the host backend is active, automatic titles use the host's `--print`; otherwise they keep using the resolved `--pi` CLI. No global `pi` fallback.
- **Hello:** consume the host's `hello` record to record protocol/capabilities (log + store on the live session for diagnostics). Do not forward `hello` to the browser as a transcript event.
- **Panels:** add `panel` to `isBlockingUiMethod` so it uses the existing `pendingUi` cache, grace timer, replay, and exactly-once `extension_ui_response` path. Replay order is insertion order.
- **Exit/restart:** host exit uses the existing `onExit` error/reattach path; no special host restart loop.
- **Test fixture:** commit `test/fixtures/fake-pi-host.mjs`, driven by env like `fake-pi.mjs`, covering hello, prompt, event forwarding, panel request/replay/answer, and shutdown.
- **Performance:** measure cold attach, warm attach, RSS and event latency against the legacy child on this box, record the numbers in the ticket and `ARCHITECTURE.md`; no pass/fail threshold, host stays opt-in.
- **Assumption:** the host package bin is resolved from the pixip install (workspace symlink in dev), not from a globally installed package. `--pi-host` with no value is the normal workspace/dev path.

### Verification (2026-11-21)

- Backend: `--pi-host [path]` / `PIXIP_PI_HOST` selects `pixip-pi-host`; same `--mode rpc --session-dir/--session/--name` args and env as legacy; `--pi` remains default.
- `hello` is consumed by the hub (logged + stored on the live session) and never forwarded as an event; `panel` is in the blocking cache/replay path.
- Host `--print` mode: in-memory session (no JSONL), no tools/extensions/skills/templates/context, optional `--model`; titles use it when the host is active.
- Tests: `test/pi-host.test.ts` (hello, event forwarding, panel replay/answer-once, shutdown, host title) and `pi-host/test/print.test.ts`; legacy backend tests remain green.
- Perf on this box (Node 22.23.5, real Pi 1.5.2 vs workspace host, 3 attaches per backend): cold 1239 -> 3745 ms; warm 1240-1331 -> 3487-3657 ms; child RSS 108-110 -> 149-152 MB; command RTT 1.55 -> 1.59 ms; event->frame median/p95 0.30/1.71 -> 0.30/1.30 ms. Recorded in ARCHITECTURE.md; host stays opt-in.
- `npm run check` green (243 tests).

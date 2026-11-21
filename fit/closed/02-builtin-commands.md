---
grilled: true
leg: tui-parity-1
commit: "527b3a4"
---

pixip owns the Pi built-in slash commands that the RPC surface can drive, so `/compact`, `/name`, `/session`, `/copy`, `/model`, `/thinking`, `/new`, `/resume` and `/quit` work from the composer like they do in the TUI. Handlers consume the catalog, policy and classifier from `00-prefix-commands`; this ticket only adds the behaviour behind those names.

### Why now

Slice 3 of the TUI-parity leg for dogfooding: a pixip session has to be manageable without a terminal (compact, rename, switch model/thinking, start/resume/quit) before development moves into pixip. Runs after `01-daemon-refresh`, so a hub restart is not the only way to reload.

### Done when

- `/compact [instructions]` calls RPC `compact` with `customInstructions`; after `compaction_end` the client requests a fresh full snapshot with a new additive `resnapshot` client frame (`resnapshot` so it does not collide with the daemon's `refresh`), so the shrunken context is what is shown.
- `/name` toasts the current name; `/name foo` calls `set_session_name` and the header updates from the existing status frame.
- `/session` renders a local meta block: Pi id, pixip logical id, session file, name, message count, model/thinking, token totals and cost (from the footer data the hub already fetches).
- `/copy` copies the last assistant message text; on clipboard failure it opens a sheet with the text and a copy button.
- `/model` with no argument opens the model sheet; `/model provider/model` or a model id resolves against `get_available_models` and sets it, with a toast on unknown/ambiguous matches. `/thinking [level]` behaves the same against `get_available_thinking_levels`.
- `/new` calls RPC `new_session`, re-keys the live session to the new Pi id, updates the index `piIds`, sends `opened` + a fresh snapshot. `/resume` returns to the session list. `/quit` detaches the session and returns to the list.
- Denied commands and the TUI-only list from `00` still produce the local notice; every handler respects the per-session policy (including after a soft refresh re-resolves it).
- `npm run check` green; `docs/parity.md` marks these commands done.

### Decisions (grilled 2026-11-21)

- `/new` uses `new_session` in the same child (TUI behaviour), not a new process; the id re-key helper introduced here is reused by `08-session-commands` (fork/clone/switch).
- `/quit` cannot quit a terminal from the browser; it stops/detaches the child and returns to the list (soft quit).
- `/session` is client-side formatting of data the hub already has; no new RPC.
- `/compact` gets a transcript refresh because a compaction entry (`type: "compaction"`) is not rendered by the live event path and the context window shrinks. The `resnapshot` client frame makes the hub send a normal full snapshot (not a resume delta).
- `/copy` uses `navigator.clipboard` (localhost is a secure context) with the sheet fallback for older mobile browsers.
- Model/thinking argument matching is a pure helper: exact `provider/id`, exact id, then unique suffix; ambiguous or unknown -> toast with the closest matches.
- All handlers are available while idle and while busy unless the RPC command itself refuses; errors surface as a toast, never as a silent failure.

### Files

`src/client/app.js`, `src/client/commands.js` (argument helpers if they belong there), `src/client/sessionInfo.js` (pure `/session` formatter, tested), `src/server.ts` (`compact`, `set_session_name`, `new_session`, `resnapshot`, `copy` data), `src/hub.ts` (command handlers + re-key helper + index `piIds` update), `src/wire.ts` (`resnapshot`/meta frames), `test/fixtures/fake-pi.mjs`, `test/`.

### Tests

- Fake Pi: `compact` (with instructions), `set_session_name`, `new_session` changing the id on the next `get_state`; integration asserts the resnapshot, the new `opened` id, and the index `piIds` update.
- Pure: `/session` formatting, model/thinking argument resolution, `/copy` text extraction from entries.

### Notes

- Do not round-trip through `get_entries` for `/session`; use the footer + `get_state` the hub already serves.
- Keep the policy/notice behaviour from `00`; this ticket must not bypass it.
- Screenshots (390/1280) are the owner's step; note the gap in the ticket when closing.

### Addendum (grilled 2026-11-21)

- `/session` renders its meta block in the existing bottom sheet (`sheet()`), not
  in the transcript: it is local UI, scrolls nowhere, and adds nothing to model
  context. Same for the no-argument `/name` readout (toast stays as decided).

### Closed (2026-11-21)

Implemented and verified:

- `/compact [instructions]` -> RPC `compact` (no response timeout); on
  `compaction_end` the client sends `resnapshot` and the hub answers a full
  snapshot with `replace: true`, so windows loaded before the compaction are
  dropped and the shrunken context is what is shown.
- `/name` toasts the current name; `/name foo` calls `set_session_name` and the
  header follows the status frame.
- `/session` opens the meta sheet (id, logical id, name, file, message count,
  model/thinking, tokens, cost, context) from data the hub already sends; no RPC.
- `/copy` fetches Pi's `get_last_assistant_text`, writes it with
  `navigator.clipboard`, and falls back to a sheet with the text and a copy
  button. Deviation from the test sketch: this uses the documented RPC instead of
  extracting from `state.entries`, because live messages never enter the client's
  entry window and extraction would copy a stale message. The wire test covers
  the text; pure tests cover `/session` and the resolvers.
- `/model` / `/thinking` open the existing sheets with no argument, or resolve
  the argument server-side (exact provider/id, exact id, unique suffix; exact
  level, unique prefix) and toast unknown/ambiguous answers with the matches.
- `/new` calls `new_session` in the same child: the hub mutates the live session
  in place (the event closure keeps working), moves it to the new Pi id, appends
  the id to the index `piIds`, and sends `opened` with `rekey` to every socket;
  each tab then requests a replacement snapshot. `/resume` returns to the list.
- `/quit` sends `stop` (soft quit: detach) and returns to the list once the
  status frame says `stopped`, with a short timer as the fallback.
- Handlers stay behind the `00` classifier, so the per-session policy and the
  TUI-only notices still apply unchanged.

Verification: browser smoke with headless Chromium at 390 and 1280 (session
sheet, rename, model/thinking, copy fallback sheet, compaction resnapshot,
`/new` URL re-key + cleared transcript, `/resume`, `/quit` -> stopped + list; no
console or page errors), and `npm run check` green with 121 tests.

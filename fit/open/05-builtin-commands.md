---
grilled: true
leg: tui-parity-1
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

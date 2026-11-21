---
grilled: true
leg: tui-parity-1
---

Typing `/` opens a filtered command list above the composer, and the status line moves below the input so the menu owns the space above the text field. This is the interaction half of the command surface from `00`; it shows built-ins, extension commands, templates and skills, and honours the per-session policy.

### Why now

Slice 4 of the TUI-parity leg: the owner cannot remember every command (and extension/skill names vary per project), and the footer currently competes with the menu for the space above the composer.

### Done when

- A `/`-prefixed composer line (no whitespace yet) shows a menu above the composer, capped at ~6 rows and scrollable, with name + description.
- Sources: supported built-ins from the `00` catalog plus `get_commands` (extension, prompt, skill) for the live session; denied commands are filtered out; TUI-only commands are shown dimmed with a "TUI-only" hint (selecting one shows the notice).
- Filtering is case-insensitive substring on name/description, prefix matches first; `↑`/`↓` move, `Enter`/`Tab` insert, `Esc` closes, tapping a row inserts; the menu closes when the line stops being a bare command or loses focus.
- The status footer moves below the composer (both stay sticky at the bottom, safe-area aware); the list view is unchanged.
- `npm run check` green and `docs/parity.md` marks the menu done; the owner runs `tools/shot.mjs` at 390 and 1280 (this box has no Chromium).

### Decisions (grilled 2026-11-21)

- Footer below input, composer above it; the menu sits directly above the composer. One asset set, CSS only, no user-agent branching.
- Menu opens only in command position (starts with `/`, no whitespace before the cursor); arguments after the command hide the menu (no argument completion in this slice).
- Built-ins come from the shared `src/client/commands.js` module (no second list); dynamic commands are fetched once per session and cached, refreshed on a reattach or a soft hub refresh (`01-daemon-refresh`).
- TUI-only commands stay visible but dimmed so the menu teaches what exists; selecting one emits the same local notice as `00`.
- No fuzzy search, no ranking beyond prefix-then-alphabetical, no icons: keep it small and testable.

### Files

`src/client/commands.js` (filter/sort module, tested), `src/client/app.js`, `src/client/index.html`, `src/client/style.css`, `src/server.ts` (`commands` frame from `get_commands`), `src/hub.ts`, `src/wire.ts`, `test/commands.test.js`, `test/` integration, `docs/parity.md`.

### Tests

- Pure: filtering/ordering, command-position detection, dimmed TUI-only rows, policy filtering.
- Fake Pi: `get_commands` response surfaces in the client frame; integration asserts it is requested once per session.
- Layout: `tools/shot.mjs` at 390/1280 by the owner (menu open + footer below input); no horizontal overflow.

### Notes

- Keep the composer usable with the physical keyboard on desktop and the on-screen keyboard on phones; the menu must not cover the input.
- The footer move is a layout change only; formatting stays in `footer.js`.

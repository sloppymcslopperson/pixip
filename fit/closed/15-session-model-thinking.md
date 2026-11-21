Each chat needs its own model and thinking level, switchable from the web UI instead of the terminal.

### Implementation

- Hub passes through `get_available_models`, `set_model`, `get_available_thinking_levels`, `set_thinking_level` over RPC.
- Client: tapping the footer opens a session sheet, then a model list (current marked `✓`) or a thinking-level list.
- Footer updates after a switch; `thinking_level_changed` events keep it in sync when changed elsewhere.

### Verified

Headless Chromium: `deepseek-v4.1-flash • low` → `claude-haiku-5-5 • low` after picking a model, and `high` → `low` after picking a level, no console errors.

Add an admin options TOML that sets program defaults, including the pending-UI timeouts, with CLI flags overriding it. This is the settings file requested during the panel UX work; it should not be confused with the existing `pixip.json` command-policy file.

### Proposed shape

- Location: `<data-dir>/pixip.toml` (same root as sessions, pid, log; isolated per instance). Create a commented example only when missing.
- Read once at daemon startup/restart; no hot reload.
- Precedence: TOML defaults < CLI flags.
- Start with pending UI, then expand to other program defaults only when needed:

```toml
[pending_ui]
timeout_ms = 18000000
open_timeout_ms = 36000000
more_time_ms = 120000
reask_reply_ms = 60000
```

### Open decisions

- Whether all program settings (`host`, `port`, `idle_ms`, `title_model`) belong in the same file or stay CLI-only.
- Whether to add a TOML dependency or keep a small in-repo parser for the supported table/key/value subset.
- What to do with malformed TOML: fail startup with the path, or log and fall back to defaults.

### Acceptance

- Admin can set the pending-UI defaults without CLI flags.
- CLI flags still win over the file.
- Malformed or unknown keys are reported with the file path.
- `ARCHITECTURE.md` / `README.md` document the file and precedence.
- Tests cover precedence, missing file, valid file and malformed values.

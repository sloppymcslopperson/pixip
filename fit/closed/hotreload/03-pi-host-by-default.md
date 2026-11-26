---
project: pixip
grilled: true
---

Spawn `pixip-pi-host` by default and make vanilla `pi --mode rpc` an explicit `--use-system-pi` opt-in. Today `dev.sh` starts the daemon without `--pi-host` and `serve()` silently falls back to the system `pi`, which disabled the A2UI panel and every host capability for all sessions in a checkout with no warning anywhere.

### Changes

- `Options.piHost` defaults to auto-resolving the installed `pixip-pi-host`; `--use-system-pi` selects the legacy `pi --mode rpc` backend.
- Keep `--pi <path>` for the binary path in both cases.
- Fail a `daemon`/`run` start with an install hint when auto-resolution fails instead of degrading.
- Log a warning when the system-pi path is active.
- `serveArgs()` records the effective choice so `restart` reproduces it.

### Acceptance

- Default `pixip daemon` (and `pixip run`) spawns the host and the child `hello` advertises `panel`.
- `--use-system-pi` spawns `pi --mode rpc` and logs the warning.
- A missing host package fails start with a clear message.
- `npm run check` green; a fresh `pixip daemon` verified with the panel path working.

### Depends

- `02-run-daemon-cli`: this ticket edits the same `parseArgs`/help/subcommand code, so it lands second.

### Notes

- Root cause of the questionnaire "no tabs" report: capability-less child, not a renderer regression.
- Command names assume `02-run-daemon-cli`; before it lands, read `pixip start`/`serve` for `pixip daemon`/`run`.

### Decisions (grilled)

- Host is the default backend. Remove `--pi-host` entirely (flag, help, README, docs, tests).
- `PIXIP_PI_HOST` remains the host-executable override. Unset means auto-resolve the installed workspace `pixip-pi-host` bin; a missing package fails `daemon`/`run` start with the install hint instead of degrading.
- Add `PIXIP_PI` for the Pi executable used by system mode. `--use-system-pi` is required for `--pi` or `PIXIP_PI`; either without the flag is a startup error.
- Pi-path precedence with `--use-system-pi`: an explicit path beats the literal default `pi`; when both `--pi` and `PIXIP_PI` are explicit and differ, `--pi` wins. Neither set is an error. `PIXIP_PI_HOST` is ignored in system mode.
- `serveArgs()` records `--use-system-pi` and `--pi`; the daemon state also records the effective `PIXIP_PI_HOST` so `restart` reproduces a custom host path. Default host mode records no host flag and re-resolves the install.
- Log one warning when the system-pi backend is active, naming the chosen executable.
- Keep the host's strict arg parser: Pi-only `extraPiArgs` stay on the legacy path only.
- Tests: parse precedence and error cases, missing-host startup failure, fake-host spawn advertises `panel`; a manual fresh `pixip daemon` verifies the real host/panel path.
- Update `README.md`, `ARCHITECTURE.md`, and `docs/TUI-parity.md` references to the removed `--pi-host` and the new default.

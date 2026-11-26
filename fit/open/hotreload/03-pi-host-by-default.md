---
project: pixip
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

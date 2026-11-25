---
project: pixip
grilled: true
---

Add a `pixip service install|status|uninstall` command so a novice can run pixip as a boot-time daemon without writing systemd units by hand. Default to a systemd user service running as the invoking user, with a system service available behind `--system`. Use a persistent service data dir (`~/pixip_data` by default, overridable) and make `pixip restart` delegate to systemd when the service owns the process.

### Problem

`pixip start` can launch a detached daemon, but it survives neither reboot nor a crash, and a novice should not have to learn unit files, `Restart=on-failure`, minimal service `PATH`s, or lingering. Cron `@reboot` is a one-shot launcher with no crash recovery and is not the documented path.

### Proposed shape

- Add a `service` subcommand with `install`, `status`, and `uninstall` actions (default action may be `install`).
- Default target: systemd user unit at `~/.config/systemd/user/pixip.service`, running as the invoking user.
- `--system`: write `/etc/systemd/system/pixip.service` and run as the sudo/invoking user rather than root; require the caller to have already chosen that privilege level.
- Resolve and write absolute paths at install time: `process.execPath` for Node, the absolute `bin/pixip.ts`, `--pi` from PATH or an explicit flag, `WorkingDirectory`, and `HOME`. Service environments must not depend on the user's shell profile.
- Default data dir for service installs: `~/pixip_data`; `--data-dir` overrides it. Keep `tmp/dev` as the development default for bare `serve`/`start`.
- Unit basics: `Restart=on-failure`, a short `RestartSec`, graceful `SIGTERM`, and `WantedBy=default.target` (user) or `multi-user.target` (system).
- For the user target, attempt `loginctl enable-linger <user>`; if it cannot, print the exact one-line sudo command and explain why it is needed for boot startup. Do not silently require root.
- `status` reports unit installed/enabled/active plus the daemon state and URL; `uninstall` stops, disables, removes the unit, and leaves the data dir intact unless explicitly asked to delete it.

### Restart integration

- Detect when pixip is running under the generated systemd unit (for example via an environment marker in the unit) and make `pixip restart` run `systemctl --user restart pixip` or `systemctl restart pixip` instead of spawning a detached replacement. This avoids systemd seeing the main process exit and starting a duplicate.
- Preserve the existing detached-helper restart path for foreground/unsupervised runs.
- For a system unit, document the polkit or narrow sudoers rule needed for agent-driven restarts; do not mount the Docker socket or grant blanket sudo.
- `restart --when-idle` must keep working through the systemd path.

### Acceptance

- From a fresh clone with `npm install`, `node bin/pixip.ts service install` writes a valid user unit, starts pixip, and survives a reboot when lingering is enabled.
- `service install --system` writes and enables a system unit for the invoking user when run with appropriate privilege.
- `pixip service status` and `pixip service uninstall` behave predictably and are idempotent.
- `pixip restart` works from inside a pixip-managed session under systemd without creating two daemons.
- The daemon uses `~/pixip_data` by default for service installs and the configured path still isolates pid/state/log/sessions.
- README gains an "Install and run" quickstart showing the service command, the optional one-time linger command, and how to reach the loopback UI safely.

### Testing

- Unit-test unit-file generation and service command parsing with a fake `systemctl`/`loginctl` runner; CI must never touch a real systemd bus.
- Cover user vs system unit paths, `--data-dir`, missing `node`/`pi`, malformed existing unit, and idempotent install/uninstall.
- Add a daemon-level test for the restarted-under-systemd decision without requiring systemd.

### Out of scope

- Full fresh-VPS provisioning, Node installation, firewall setup, reverse proxy, or auth; that is a separate ticket.
- launchd, Windows services, and non-systemd Linux init systems; `--system` may fail with a clear message and cron/Docker remain manual alternatives.
- Publishing the package or providing a global installer.

### Grilled decisions

- `pixip service` with no action prints service help; only `install`, `status` and `uninstall` are actions.
- `service install` refuses when an unmanaged daemon already owns the same data dir/port, and tells the user to run `pixip stop` first.
- Existing unit behavior: refuse if any file already exists at the target path, even a pixip-generated one, unless `--replace` is passed. `--replace` overwrites the file.
- The unit embeds the complete effective serve arguments (host, port, data dir, pi/pi-host, timeouts, title model, command policy, etc.). Once `open/60-options-toml-defaults.md` lands, any argument not explicitly supplied on the install command falls back to `pixip.toml`; until then it falls back to the normal CLI defaults. The TOML ticket has been annotated with this requirement.
- `service uninstall` keeps the data dir by default; `--delete-data` removes it explicitly.
- User service: install attempts `loginctl enable-linger <user>`; on failure it prints the exact sudo command and explains that boot startup needs lingering.
- System service user selection: `--user <name>` must name an existing account; `--user self` resolves to `SUDO_USER` and then the current euid user; with no `--user`, the service runs as the `pixip` service user. On a TTY, defaulting to `pixip` asks for confirmation first; non-interactive installs proceed automatically.
- The `pixip` account is an unprivileged system user created with `useradd --system --create-home --shell /bin/bash pixip` when absent, and reused when present.
- Service data dir defaults to `~/pixip_data` for the selected service user. `WorkingDirectory` defaults to `~/dev` (created if missing) until the TOML config can override it.
- `pixip restart` under the generated unit keeps the busy/`--when-idle` checks, then uses a detached helper to run `systemctl --user restart pixip` or `systemctl restart pixip`. `pixip stop` under the unit delegates to `systemctl stop`. Foreground/unsupervised runs keep the current detached-helper path.
- Unit generation and service parsing are covered with an injected fake `systemctl`/`loginctl` runner; tests never touch a real systemd bus.

### Implementation

- Added `src/service.ts`: unit generation/quoting, metadata parsing, service-account resolution (including `--user self` and the default `pixip` account), injectable `systemctl`/`loginctl` runner, install/status/uninstall, installed-unit discovery, and the systemd restart decision.
- Added `pixip service install|status|uninstall` parsing and output in `bin/pixip.ts`. Install writes the complete `ExecStart`, creates `~/pixip_data` and `~/dev`, attempts user lingering, and reports the exact sudo line on failure. Status is idempotent and reports unit/daemon state; uninstall is idempotent and keeps data unless `--delete-data`.
- `pixip restart` and `pixip stop` detect a generated unit via `PIXIP_SERVICE` or the unit's recorded data dir + systemd `MainPID`. Restart keeps busy/`--when-idle` checks and uses a detached helper running `systemctl [--user] restart pixip.service`; stop delegates to `systemctl stop`.
- Added `test/service.test.ts`: unit generation, user/system paths, account resolution, malformed/existing unit refusal and `--replace`, missing executables, idempotent install/status/uninstall, unsafe data-dir refusal, and an integration test that an agent inside pixip restarts through a fake `systemctl` without creating two daemons.
- README gained the "Install and run" quickstart, linger command, service-user behavior, agent restart notes, the narrow polkit rule for system units, and the loopback safety warning.
- Annotated `open/60-options-toml-defaults.md` so the future TOML loader is also used as the service-argument fallback.
- Verification: `npm run check` green (with inherited `PIXIP_*`/`PI_SESSION_*` unset for the test run, matching `open/20-test-harness-pixip-env.md`).

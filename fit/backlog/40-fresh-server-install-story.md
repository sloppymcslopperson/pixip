---
project: pixip
---

Design the approachable fresh-server install story: getting from a new DigitalOcean VPS or a personal PC used as a server to a working, safely reachable pixip. Keep it as a separate follow-up to `pixip-service-install`, since the service command is the prerequisite.

### Problem

A novice can clone the repo and run `npm install`, but provisioning a fresh Linux image still means choosing a user, installing Node, cloning or unpacking a release, surviving reboots, opening the right ports safely, and knowing how to reach an unauthenticated loopback UI. The current README assumes a developer who already has the repo and knows their way around a daemon.

### Proposed shape

- A documented one-command path, either a checked-in `install.sh` or a release tarball + small installer, targeting Debian/Ubuntu first.
- Safe defaults: create/use a non-root user, keep the UI on loopback (or a private VPN interface), and never publish port 8137 to the public internet by default. Prefer SSH tunneling in the quickstart, e.g. `ssh -L 8137:127.0.0.1:8137 user@host`.
- Install prerequisites with clear checks and errors: Node >=22.19, git, and Pi itself. Do not silently install a system Pi that conflicts with the user's existing managed Pi install; document or detect the supported Pi installation method.
- Clone or unpack into a stable directory, run `npm ci`, then delegate boot/crash supervision to `pixip service install` rather than reimplementing systemd logic.
- Use a persistent data dir (`~/pixip_data` by default) and explain sessions, logs, pid/state, and how to back them up.
- Document update and recovery paths: `pixip restart --when-idle`, `git pull` plus `npm ci` as applicable, logs, status, and how to stop/uninstall without deleting data.
- Provide guidance for the PC-as-server case: user service plus lingering, versus a system service, and what happens before login.
- Offer Docker Compose as an optional parallel path for users who already run containers; include `restart: unless-stopped`, `init: true`, a persistent volume, and loopback-only port mapping. Do not make Docker the only path.

### Acceptance

- A reader starting from a fresh Debian/Ubuntu VPS can follow the documented steps end to end and reach the UI through an SSH tunnel.
- Reboot leaves pixip running, and a crash is recovered by the service supervisor.
- The guide states the auth posture and firewall implications explicitly; no step tells the user to expose the unauthenticated UI publicly.
- Update, backup, stop, and uninstall instructions are present and preserve session data unless the user explicitly deletes it.
- Any installer script is testable/dry-runnable and fails with actionable messages for unsupported OS, missing Node, missing Pi, or an existing installation.

### Dependencies

- Depends on `pixip-service-install` for boot startup, unit generation, and self-restart behavior.
- Pi installation/version support may need its own decision before the script can be fully automatic.

### Out of scope

- Changing the no-auth posture or adding a public authenticated deployment; that is separate work.
- Windows and macOS support in the first pass.
- A hosted service, managed upgrades, or billing.

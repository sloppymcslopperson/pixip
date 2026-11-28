# Press release FAQ — working notes

Derived from the discussion. Status tags are for the audit:
**[settled]** decided, **[building]** in progress, **[planned]** later,
**[verify]** claim to check against current or in-ticket behavior.

This file explains the PR; it does not override it.

## Positioning

**What is PixiP?**
A self-hosted web front-end for Pi coding agents, running on your own hardware.
It starts, watches, answers and resumes sessions from a phone or desktop. Not a
hosted service, not a replacement for Pi.

**Who is it for?**
One technical person running several sessions on a machine they control, plus
trusted collaborators. Not teams, not multi-tenant, no roles. **[settled]**

**Is it a Pi replacement?**
No. Pi is the agent; PixiP is the workspace around it. **[settled]**

## Pi

**Do I need Pi installed?**
No. PixiP ships its own Pi binary. **[settled]**

**Does it use my existing Pi setup?**
Yes. It reads the same `~/.pi` configuration, extensions, provider connections and
auth, whether it runs the bundled Pi or yours. **[settled]**

**Can I use my own Pi instead?**
Yes, one flag. Same configuration either way. The active binary and version are
shown. With your own Pi, A2UI falls back to plain panels. **[settled]**

**Why bundle Pi when it reads the same config?**
Two reasons: a fresh install needs no Pi prerequisite, and A2UI needs a small
wrapper around the vendored Pi that the stock RPC layer does not provide.
**[settled]**

**What breaks in system-Pi mode?**
A2UI only, as far as we know, and it degrades to plain panels. The workflow still
works. **[verify]** — confirm the gap list and that the fallback renders, not errors.

**Will my extensions work?**
They load from the same directories. Version skew is PixiP's responsibility: if
the bundled Pi is older than an extension expects, PixiP broke it. Show the
versions, state the supported range, and fail extension load with the required
version. **[settled]**

## Security and deployment

**Does PixiP authenticate users or sandbox agents?**
No. Authentication, authorization and sandboxing are the host's job. **[settled]**

**How do I know who sent a message?**
If the host supplies `X-Forwarded-User`, PixiP displays it as attribution. It never
gates an action. It is only meaningful when PixiP is reachable only through the
proxy that sets it. **[settled]**

**Can I expose it to the internet?**
It is designed to sit behind your tunnel, VPN or proxy. If you bind it publicly,
that is your call and your responsibility, and the app says so. **[settled]**

**What does the process need?**
No root. It binds only to the address given at startup, keeps the endpoint surface
minimal and documented, and can be wrapped in Docker, a MicroVM, a VPS or any
other sandbox without losing features. **[verify]** — "no special permissions" and
"exact connection parameters" against the current flag set.

**Are the HTML reports safe?**
Reports are sanitized. "Safe" needs a test: no script execution and no reach to
the app's endpoints. Until that test exists, say "sanitized", not "safe".
**[building]**

## Sessions and devices

**What happens when the network drops?**
Transcripts are durable; reconnecting resumes where you left off. A mobile browser
that closes a socket reconnects quickly. **[verify]** — against the reconnect and
cursor behavior.

**Can I use more than one device?**
Session activity is broadcast to connected devices, so you can hand off between
phone and desktop. The hard case is two devices sending at once. **[verify]**

**Is pair-programming supported?**
Multiple trusted people can see the same sessions, and the header shows who sent a
message. There are no roles or per-user permissions. **[verify]** — decide whether
"pair-programming" is the right word for that.

**What about notifications?**
Mechanism unspecified. If it means web push, it depends on PWA, which is deferred.
If it means in-app notification while a tab is open, it is independent.
**[verify]**

## Features and status

**Worktrees?**
Create and a streamlined agentic merge workflow. **[verify]** — current or
in-ticket.

**Hot reload?**
Current or in progress: extensions and app changes are visible immediately.
**[verify]** — client assets only, or server code too.

**Sysadmin lock-down?**
A single flag makes the instance predictable. **[verify]** — exactly what it
disables: config edits, hot reload, self-modification, or all three.

**Config format?**
`config.toml` is planned, not current; the current app uses JSON. **[planned]**

**PWA?**
Planned, deliberately late. Hot reload in a PWA is the complication; excluded from
current promises and from the first rewrite pass. **[planned]**

**What is not current today?**
Known: PWA, TOML. To verify: Windows/macOS support, web push, pair-programming,
the lock-down flag, hot reload of server code. **[verify]**

**How is it built?**
PixiP is developed in PixiP. Features are proven in the current prototype first;
the rewrite re-implements proven behavior. PWA is the deliberate exception.
**[settled]**

## Open items for the audit

1. Pi: confirm bundled-vs-system behavior, version display, and the A2UI-only gap.
2. Platforms: Windows/macOS/Linux — current or in-ticket?
3. Notifications: in-app or web push, and therefore PWA-dependent or not.
4. Reports: does sanitization exist, and is the output isolated from the app origin?
5. Pair-programming: is multi-user real, and is attribution enough without roles?
6. Lock-down flag: what it actually disables.
7. Hot reload: client assets only, or server code and extensions too.
8. Worktree merge workflow: current or in-ticket.
9. Config: JSON today, TOML planned; confirm no schema promises in the PR.

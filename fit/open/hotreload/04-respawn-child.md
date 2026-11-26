---
project: pixip
---

Let the hub respawn a single session's child from its JSONL with the daemon's current spawn configuration, so a system-pi child or a changed `--pi-host` can be migrated without a daemon restart. `/reload` uses this when it meets a system-pi child; the daemon-wide restart is not required.

### Scope

- `respawnSession(id)` in `hubLive`/`hubControl`, reusing the existing reattach-from-JSONL path.
- Only when that session is idle: no turn, no pending UI, no running bash.
- Preserve the logical id, transcript anchor and durable cursor; announce with a status frame.
- On failure, leave the old child untouched and report.

### Acceptance

- A system-pi session respawned as a pi-host session mid-run; transcript and URL stable.
- Refuses while the session is busy.
- A failed spawn leaves the previous child serving.
- Tests with the fake host fixture.

---
project: pixip
grilled: true
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

### Decisions (grilled)

- `respawnSession(id)` is an internal public Hub method only. No browser control frame and no `pixip respawn` CLI; `/reload` is the only caller.
- Gate: only a live session in `idle`, with no `pendingUi`, no `bashId`, and no turn awaiting `agent_settled` may respawn. A starting/error/stopped or unknown session refuses with a reason and leaves everything untouched.
- Reuse the existing attach-from-JSONL path with the daemon's current `piHostBin`/`piBin`/env/extra args; preserve the logical id, `sessionFile` transcript anchor, durable index and cursor, then announce with the normal status frame.
- Start the replacement child first and close the old one only after the new child has answered `get_state`, so a failed spawn leaves the previous child serving. Report the failure; do not delete the old live entry early.
- Track the effective backend on the live session (`host` vs `system`) so `/reload` can find system-pi children without guessing from argv.
- `/reload` auto-respawns every system-pi child to the daemon's current configuration, then treats it as a freshly reloaded host child. There is no report-only path in normal `/reload`.
- Tests use the existing `fake-pi-host.mjs` and `fake-pi.mjs` fixtures (no new fixture): migrate a fake-pi session to the fake host, assert the transcript/URL stay stable, assert busy refusal, and assert a failed spawn leaves the old child serving.

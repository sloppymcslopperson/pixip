---
project: pixip
grilled: true
---

Add optional pause/resume steering around reload and restart so a force operation can ask active sessions to stop cleanly and then resume afterward. This is a follow-up from the hot-reload grill, not part of tickets 06-08.

### Behaviour

- Before a forced `/pixup-restart` (and optionally a forced `/reload`), offer to send every active session a steering message such as: "The user would like to reload the session. Please pause your work so that you can resume it once the reload is done."
- Persist which sessions were asked to pause, including their logical ids and the pre-operation state.
- After the daemon is healthy again, send each of those sessions a resume prompt such as: "Reload is finished, please resume."
- Make the pause/resume opt-in per operation, and show the plan in the same inline confirm card as the force path.

### Edge cases

- A session that finishes or errors during the pause window should not receive a resume prompt.
- A session whose child was replaced or whose logical id changed should be skipped and reported.
- The resume prompt must not fire when the operation was refused or failed before the daemon replacement/commit point.
- A turn already streaming when the pause steering arrives keeps the existing interruption semantics; do not pretend the pause was acknowledged unless the child reports it.

### Acceptance

- Forced restart with pause/resume enabled posts the pause steering to every active session, then the resume prompt after reconnect.
- Sessions skipped or failed are named in the final report.
- Without the opt-in, behaviour is exactly the current force path.
- Client test coverage for the confirm card and the ephemeral report rows.

### Depends

- `06-pixup-restart`

### Grilled decisions

- Scope: both a forced `/pixup-restart` and `/reload`. `/reload` gains an opt-in pause path; it still never reloads from a refusal without an explicit card action.
- Opt-in UI: the inline confirm/refusal card gets an unchecked `Pause and resume sessions` checkbox. The action button is `Force restart` (restart) or `Pause & reload` (reload). The choice is per operation and is not persisted.
- Pause targets: only the sessions named by the gate (`restartBlockers()` for restart, `reloadBlockers()` for reload). Idle sessions receive no pause or resume message.
- Pause wait: send the steering, then poll the same gate until the targeted sessions settle, bounded at 30 s. Restart: if still blocked after 30 s, paint the force card (the existing `Force restart` action). Reload: the card offers `Wait longer`, `Cancel current reload (keep pause requests)`, and `Cancel current reload (remove pending pause requests)`.
- Pause set: a new `<data-dir>` JSON file records the targeted logical ids plus their pre-operation state. It is written before the restart helper is spawned and before `runReload` commits. The replacing daemon consumes it after reattaching the live set; a paused reload consumes it in the same process after `reloadChildren`.
- Resume: sent as a steering prompt (`hub.steer`) with the fixed text `Reload is finished, please resume.` A session that was never reattached, finished, errored, or whose logical id changed is skipped and named in the report.
- Reload resume/skip: resume a paused session only when it is still live and `idle`/`stopped` after `reloadChildren`; children that failed to reload or ended in `error` are skipped and named.
- Report: the card lists the pause targets and the plan before confirming; after the operation the client paints ephemeral rows (never JSONL) naming resumed and skipped/failed sessions. Resume never fires when the operation was refused or failed before the commit point.
- Tests: hub/server integration for the pause set, skip rules and both resume paths; client test for the checkbox card and the ephemeral report rows.

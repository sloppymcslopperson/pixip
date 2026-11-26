---
project: pixip
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

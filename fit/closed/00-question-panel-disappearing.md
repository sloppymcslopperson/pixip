---
grilled: true
commit: "4adb313ca02ee194e28a873dcaca40b7e77fa5cf"
---

When an agent sends up a set of questions with no browser attached, the hub should not cancel them after the current 2-minute grace. Keep blocking requests pending, with a long configurable timeout and a recorded recovery path for re-asking after the session is resumed.

### Decisions

- Hub owns the blocking-request lifetime. Timeout is a `pixip-pi-host`/extension-UI concept, not part of A2UI, so remove the questionnaire's 15-minute panel timeout and let the hub timer decide. Extensions that explicitly ask for a shorter timeout keep their own behavior.
- Two configurable defaults: 5 hours when no client is attached, 10 hours when a browser is attached. A work day must fit inside the attached window. `0` disables the timer.
- The timer runs regardless of attachment; an ignored panel expires and is cleared on the next render.
- On expiry: send `extension_ui_response { cancelled: true }` so Pi settles, then immediately enqueue a follow-up prompt asking the agent whether the request should be re-offered when the session resumes.
- Parse the next assistant text for YES/NO. Wait 60 seconds for a reply; if none or ambiguous, default to YES.
- If YES, store the raw request and enough context in the data directory as JSON. Remove the record when it is re-asked or dismissed.
- On reconnect/session resume, show a read-only re-ask card for every blocking method (panel rendered as stored; simple dialogs described). The card's re-ask button sends the agent a prompt containing the recorded request so it can issue the same call again.
- Answered requests still do not replay. `/new`, archive, delete and session stop must clear or carry the relevant records.
- Update `ARCHITECTURE.md` (pending-UI lifetime and timeout numbers are source-of-truth), `README.md`, and `test/pending-ui.test.ts`; add coverage for the timeout prompt, YES/NO parsing/default, data-dir record lifecycle, and reconnect re-ask. Add a questionnaire test that no 15-minute panel timeout is passed.

### Out of scope

- The `Submit` → `Submit all` label is a separate follow-up ticket.
- Sleeping or suspending the Pi child while a dialog is pending; Pi's RPC protocol has no resume-the-same-call operation.

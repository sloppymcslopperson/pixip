---
project: pixip
---

A session whose dot goes red needs to reach the user even when nobody is looking at the dashboard, so a terminal enough error should leave a message in the pixip inbox.

### Context

- The reload/restart gate treats `error` as non-blocking, which is only safe if the failure is visible elsewhere.
- Today a red dot is silent unless the user opens the dashboard.

### Acceptance

- A transition into `error` that is judged terminal writes one inbox message naming the session, cwd, and error.
- No duplicate messages for repeated failures of the same session; a successful reattach clears the condition.
- Reload/restart stay unblocked by error state.

### Open

- Which errors count as terminal (child exit with non-zero vs. a refused resume).
- Whether the message is a new inbox purpose or reuses `attention-needed`.

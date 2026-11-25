---
grilled: false
project: pixip
---

After a compaction the user can still see pre-compaction history, but has no way to bring one of those messages back into the agent's active context.

### Decisions

- Touching a user message before the newest compaction boundary offers a `remind agent` action.
- The action prefills the composer with a quoted reminder plus a note that the message predates the last compaction; it never sends on its own.
- The user can edit the reminder before sending.

### Acceptance

- Pre-compaction user messages expose a remind action; messages after the boundary do not.
- The prefilled text identifies the original message as pre-compaction and quotes it, with a clear instruction to use it as current context.
- Sending is still an explicit user action; selecting remind never moves focus away from the composer draft unexpectedly.
- `npm run check` green plus 390/1280 screenshots.

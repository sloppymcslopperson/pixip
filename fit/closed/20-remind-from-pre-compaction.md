---
grilled: false
project: pixip
series: chipwitch
---

After a compaction the user can still see pre-compaction history, but has no way to bring one of those messages back into the agent's active context.

### Decisions

- Touching a user message before the newest compaction boundary offers a `remind agent` action.
- The action prefills the composer with a quoted reminder plus a note that the message predates the last compaction; it never sends on its own.
- The user can edit the reminder before sending.

### Relationship to the ref series

`open/chipwitch/` adds `[ref=…]` tags, a copy action and an in-session insert default for any message, pre-compaction ones included (they stay in the JSONL and are still painted, so they are already addressable). If those land first, this ticket shrinks to a preset on top of them: the pre-boundary affordance inserts a ref tag plus whatever reminder wording survives grilling, instead of a bespoke quoting path. Decide which before implementing either, so the quoting logic exists once.

### Acceptance

- Pre-compaction user messages expose a remind action; messages after the boundary do not.
- The prefilled text identifies the original message as pre-compaction and quotes it, with a clear instruction to use it as current context.
- Sending is still an explicit user action; selecting remind never moves focus away from the composer draft unexpectedly.
- `npm run check` green plus 390/1280 screenshots.

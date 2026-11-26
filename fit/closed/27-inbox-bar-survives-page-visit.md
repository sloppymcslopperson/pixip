---
grilled: true
project: pixip
---

The dashboard inbox bar disappeared as soon as the inbox page was opened and the user came back, because `loadInbox` replaced `state.inbox` with the list response, which carries neither `newest` nor the extension flag. Keep the bar's summary fields when a list snapshot refreshes the counts.

### Fix

- `mergeInboxSummary(inbox, list)` in `inboxModel.js`: counts (`unread`, `total`, `limit`) come from the list snapshot, `newest` and `extension` are preserved from the live summary, so the bar stays visible for read messages and for an announced addon.
- `loadInbox` in `inbox.js` uses it instead of assigning `normalizeInbox(list)` over the bar state.

### Acceptance

- Dashboard → open inbox page → back: bar still shows the newest subject and its unread badge state.
- Bar stays visible for read messages and for the announced addon; it hides only when the inbox is empty and no addon announced, or every message is archived.
- Verified with a puppeteer run against the live daemon at 390 and 1280: `#inbox-bar.hidden` false before, during (page), and after returning, with the same subject.
- `npm run check` green (423 root tests + workspaces).

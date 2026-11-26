---
grilled: true
project: pixip
---

The dashboard always shows the inbox bar, even on a data dir with no messages and no pixip-inbox addon installed, so the bar is dead chrome on a fresh install. Show it only when there is at least one non-archived message, or when the optional addon is loaded.

### Goal

Hide the inbox bar while the inbox is empty and `inbox_send` is not available; show it as soon as either becomes true.

### Decisions

- Detection is a self-report, not config parsing: the `pixip-inbox` extension POSTs `api/inbox/extension` once on load (it already has `PIXIP_DAEMON_URL` and `PIXIP_INBOX_TOKEN` from the hub). The hub never guesses from `~/.pi/agent/settings.json`, auto-discovery dirs or `-e`.
- The flag is in-memory for the daemon run. A restarted daemon hides the bar until the next session with the addon loads; no stale marker if the addon is uninstalled, and any existing message still shows the bar.
- "Empty" means no non-archived message (`newest` is absent). Archived-only inboxes stay hidden.
- `#inbox` stays reachable by URL and still renders the empty state; nothing links to it while the bar is hidden.
- The flag rides the existing `inbox` frame as an additive optional field, so no `WIRE_VERSION` bump and no event-path re-encoding.

### Scope

Hub: `inboxSummary` gains `extension: true` when announced, new `inboxAnnounce` sets it once and rebroadcasts, `POST /api/inbox/extension` behind the existing inbox token seam. Extension: best-effort announce on load, failures swallowed (a missing daemon is not an extension error). Client: pure `inboxVisible(summary)` in `inboxModel.js`, `renderInboxBar` owns `hidden` and keeps the bar out of session and inbox-page views.

### Acceptance

- Fresh data dir, addon not loaded: no bar on the dashboard.
- Addon loaded (`pixip-inbox` in the Pi package list) with zero messages: bar shows "inbox / no messages yet".
- One sent message with the addon absent (CLI sender): bar appears with the unread badge.
- Announce is idempotent and authorized; a bad token gets 401 like the rest of the inbox API.
- Session view and `#inbox` never show the bar; late frames do not re-show it.

### Tests

- `test/inbox.test.ts`: announce flips the summary, is idempotent, and 401s without the token.
- `test/inboxModel.test.js`: `inboxVisible` over empty/addon/message/archived-only.
- `extensions/pixip-inbox/test/inbox.test.ts`: announce hits the endpoint, swallows a missing daemon.
- `npm run check` green; `tools/shot.mjs` at 390 and 1280 on a fresh data dir and on one with a message.

### Result

- `inboxVisible(summary)` = a non-archived newest message or `extension === true`; `renderInboxBar` owns `hidden` and keeps the bar out of the session view and the inbox page by checking `ui.list.hidden`, so a late frame cannot re-show it there. `dashboard.showList` reaches the renderer through the `configureDashboard({ renderInboxBar })` boundary (the client import guard rejects a direct dashboard → inbox import).
- Hub: `POST /api/inbox/extension` behind the existing token seam, `inboxAnnounce` sets the flag once per daemon run and rebroadcasts the `inbox` frame; summary carries `extension: true` only after that.
- Extension: `announceInbox()` on load, best-effort (no URL, 401, or a dead daemon all return false and stay quiet).
- Verified with `tools/shot.mjs`: fresh data dir at 390 and 1280 shows no bar; after the announce the bar shows "inbox / no messages yet"; a CLI-sent message with no announce shows the bar and unread badge at 390 and 1280; `#inbox` still renders by URL and does not show the bar.
- `npm run check` green: 422 root tests plus the four workspace suites, tsc, eslint, prettier and the client import guard.
- One limit worth naming: after a daemon restart the bar is hidden until the next Pi child loads the addon, by design (in-memory flag, no stale marker after an uninstall).

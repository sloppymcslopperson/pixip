---
grilled: true
project: pixip
---

Give the inbox a dashboard surface: a header icon with an unread badge, an inbox sheet with filters and archive/delete, cap warnings, and a tap-to-session reply path.

### Settled decisions

- The inbox icon lives in the dashboard header only, with an unread count badge; not in the session header.
- Sheet lists newest first: subject, purpose, body (rendered as text, never HTML), sender name + short logical id, dynamic sender status, time, read state.
- Sender status: running/idle/stopped/archived/deleted, resolved from the hub data already received. Tapping a non-deleted sender opens the session and prefills the composer with `[inbox <short-id>] `; a deleted sender shows the snapshot and no link.
- Archive hides rows behind a toggle and is restorable; delete is permanent with a confirm.
- Filters: all / unread / purpose.
- Cap warnings: badge warning colour at 50 %, error colour at 99 %, plus one toast per threshold per browser.
- Responsive by contract: one asset set, checked at 390 and 1280.

### Files

- `src/client/index.html` and a header/badge style (existing CSS split)
- new `src/client/inbox.js` (sheet + pure list/filter/count helpers), `src/client/inboxModel.js` if the model warrants its own testable file
- `src/client/app.js`, `frames.js`, `navigation.js` wiring; `tools/check-client-imports.mjs` cluster map
- `test/` pure model tests, `tools/browser-check.mjs` flow, `tools/shot.mjs` at 390/1280

### Acceptance

- Dashboard shows an unread badge that updates from the `inbox` frame without a reload.
- Reading a message marks it read; mark-all works; archive hides and restores; delete confirms and removes.
- Tapping a live/stopped sender opens the right session with the prefilled inbox id; a deleted sender does not navigate.
- The 50 %/99 % warnings appear once per threshold and do not spam on every frame.
- No horizontal overflow at 390 or 1280; `npm run check` green.

### Grilling

Further grilling is welcome for sheet copy, filter chip layout, and how the badge behaves while the sheet is open. The decisions above are settled.

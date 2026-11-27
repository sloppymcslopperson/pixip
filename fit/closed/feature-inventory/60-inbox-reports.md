---
area: inbox-reports
part: inventory
project: feature-inventory
commit: "7c6edead49d54d3fd840fa6ed8b7a06d40679191"
---

Capture the inbox as a user surface: messages, unread state, filters, reply-to-session, and reading HTML reports. The agent-facing send/report tools are owned by the bundled-extensions section; this section owns consumption.

### Goal
An inventory reader should understand how messages reach the user, how the inbox page works, and how a report is read on a phone without leaving pixip.

### Scope
- Inbox messages with subject, body, purpose (`attention-needed`, `deliverable`, `reports`, `extra-info`, `no-rush`) and optional report attachment.
- Dashboard bottom bar: newest message preview, unread badge, hidden while empty and no inbox extension loaded.
- Dedicated inbox page: all/unread/purpose/archived filters, read/unread, archive/restore/delete, full-height scroll.
- Tap-to-reply to a session: prefill the composer without sending.
- HTML reports: create/write/show, local assets, sandbox rules (no JavaScript, iframes, external loads or form submission), report landing/edit restrictions, and phone/desktop rendering.
- Empty state, unread counts, and the relationship between inbox messages and agent sessions.

### User stories to cover
- As a user, I want a quiet bar to tell me there is a message and how important it is, without interrupting my session.
- As a user, I want to filter unread or urgent messages and archive them once handled.
- As a user, I want to reply to a message by starting a session with the context prefilled.
- As a user, I want to open a report on my phone and scroll it comfortably, with images that work offline.
- As a user, I want to trust that a report cannot run scripts or load remote content.

### Wireframes (SVG, no screenshots)
- Series of screens: dashboard inbox bar, inbox list with filters, message detail, report view on phone and wide, empty state.
- Decision-flow diagram: message arrives -> unread badge -> open -> read/archive/reply/report -> restore or delete.

### Technical notes (port-relevant only)
- Where messages are stored, how unread state is derived, and the report directory/asset ownership boundary.
- The report sandbox and why scripts/external resources are rejected.
- How the bar detects the inbox extension without polling.

### Sources to read
`src/client/inbox*.js`, `inboxModel.js`, `src/inbox.ts`, `src/inboxReport.ts`, `src/hubInbox.ts`, `extensions/pixip-inbox/README.md`, `README.md` inbox and report sections, `ui_work/UI_WIDGET_BREAKDOWN.html` (inbox/report parts).

### Acceptance
- Messages, bar, page, filters, reply, reports and sandbox are each covered.
- Empty and no-extension states are documented.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/60-inbox-reports.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

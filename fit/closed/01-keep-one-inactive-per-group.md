---
project: pixip
grilled: true
commit: "97735df9167154be5d21438ce5d30313cdd54685"
---

Bulk archive should leave the newest session in any cwd group whose sessions are all inactive, so archiving never makes that group disappear. Groups that still have an active session keep their existing behavior and archive every stopped session.

### Decisions

- "Group" is the dashboard's cwd group.
- An inactive session is `state === "stopped"`; idle/busy/starting sessions keep the group alive.
- When every session in a group is stopped, keep the newest one (the first row, same ordering as the list) and archive the rest.
- The dashboard button count must show the number that will actually be archived, and the button is absent when that number is zero.
- The hub bulk endpoint accepts the explicit session ids from the client; no grouping rule is duplicated server-side.

### Acceptance

- All-stopped group with 3 sessions: bulk archive leaves 1 and archives 2.
- Group with an active session and 3 stopped sessions: bulk archive archives all 3.
- All-stopped group with 1 session: nothing is archived and no bulk button is shown if there is nothing else to archive.
- Confirmation count, result toast and list refresh all match the actual targets.
- `npm run check` green and `tools/shot.mjs` at 390/1280.

### Files

- `src/client/dashboardModel.js`, `src/client/dashboardList.js`, `src/client/dashboardSettings.js`
- `src/server.ts`, `src/hub.ts`, `src/hubStore.ts`
- `test/dashboardModel.test.js`, `test/archive.test.ts`
- `ARCHITECTURE.md`, `README.md`

### Verification

- Unit tests cover the all-stopped keep rule, the active-group archive-everything path, a one-session group, and the server-side ids filter.
- Puppeteer against a synthetic two-group data dir (3 + 2 stopped sessions):
  button showed `archive inactive (3)`; the sheet said groups with no active
  sessions keep their newest session; confirming left one session per group,
  kept 2 group sections, toasted `archived 3`, and removed the button.
- `tools/shot.mjs` at 390x844 and 1280x800: no errors or overflow.
- `npm run check` green with `PIXIP_INSIDE`, `PIXIP_SESSION_ID` and
  `PI_SESSION_FILE` unset.

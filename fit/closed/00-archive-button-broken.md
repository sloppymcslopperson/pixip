---
grilled: true
commit: "3c04c2c0e9b3166cd06c7c93c3e5294e357c5102"
---

archive button broken. The one on the dashboard. It no work.

### Investigation (recovered from the crashed 2026-11-23 session)

The previous agent could not reproduce the failure on a copy of the live data
(`tmp/archbug`, port 8140):

- Row `⋯` opens the actions sheet (`archive`, `delete`, `close`), and
  `archive` opens a confirm step (`archive`, `cancel`); confirming posts
  `POST /api/sessions/:id/archive` and removes the row.
- Bulk `archive inactive (N)` prompts `Archive N inactive sessions?`; confirming
  posts the archive requests and removes the inactive rows.

No source change was left behind. The open questions from that session were
never answered (the questionnaire panel closed without a response):

1. Which control is broken: row `⋯ → archive`, bulk `archive inactive (N)`,
   Settings → `archived`, or another button?
2. What exactly happens (nothing, error toast, session stays listed, wrong sheet,
   stuck dialog), on which device/browser, and was the session busy, idle, or
   stopped?

### Next step

Answer the two questions above, then grill the remaining ticket decisions before
implementing.

### Decisions (2026-11-23)

- Broken control: bulk `archive inactive (N)` on the dashboard.
- Symptom: tapping it does nothing at all on an iPhone Safari tab.
- Root cause: this is the only archive path that calls native
  `window.confirm`. Row archive already uses the app-owned `confirmSheet`, and
  Settings → `archived` uses no native dialog. iOS Safari can suppress native
  confirm prompts, which leaves the handler returning immediately.
- Fix: replace the native confirm with the existing in-app `confirmSheet`, so
  the action is visible and cancellable without a browser dialog.
- Scope: bulk archive only. Row archive, Settings → `archived`, and permanent
  delete are unchanged (permanent delete has the same native-confirm pattern and
  is a possible follow-up ticket).
- Acceptance: tapping `archive inactive (N)` opens an in-app sheet with the
  count; `archive` posts `/api/sessions/archive-inactive`, refreshes the list and
  toasts the result; `cancel` leaves the list untouched; no native confirm is
  used on this path.
- Files: `src/client/dashboardSettings.js`, plus a regression test.
- Verification: `npm run check`; a Puppeteer flow that clicks the bulk button,
  asserts the in-app sheet appears, and confirms the rows disappear; `tools/shot.mjs`
  at 390 and 1280.

### Verification

- `npm run check` green with `PIXIP_INSIDE`, `PIXIP_SESSION_ID` and
  `PI_SESSION_FILE` unset (the daemon tests restart instead of stopping when the
  check runs inside a pixip session).
- Puppeteer against a copied data dir on port 8142: clicking
  `archive inactive (20)` opened the in-app sheet (`archive` / `cancel`) with no
  native dialog; `cancel` left all rows; confirming posted the bulk archive,
  removed the rows, and toasted `archived 20`.
- `tools/shot.mjs` at 390x844 and 1280x800: no console/page errors, no horizontal
  overflow; dashboard layout unchanged.
- Regression test: `test/dashboardArchive.test.js` asserts the bulk archive path
  uses `confirmSheet` and not `window.confirm`.

---
area: dashboard-sessions
part: inventory
project: feature-inventory
---

Capture the dashboard as the product's home surface: session discovery, grouping, creation, state visibility, settings, and archive/trash management. This section describes what a person sees and does before opening any transcript, on phone and wide layouts.

### Goal
An inventory reader should understand how a user finds, creates, starts, stops, archives and restores sessions, and what the dashboard communicates at a glance.

### Scope
- Grouped session list by repository and worktree; collapsed-by-default groups; hot/warm/newest visibility rule and its device-local setting.
- Session row anatomy: name, cwd/branch, state dot and precedence (`error` > waiting > `idle` > `busy` > `stopped` > `starting`), last activity, actions menu.
- New session entry points: typed path, home-fenced directory picker (`browse`), a group's `+`, and `new with worktree`.
- Open, stop, wake/reattach, rename from the list, archive, delete with undo, and `archive inactive`.
- Bulk selection/archive, empty state, header bar (back, title/subtitle, dot, settings, stop, overflow: scale and reload).
- Settings sheet, archived view, trash view, and restoring or permanently deleting from each.
- Dashboard bottom inbox bar only as a cross-reference to the inbox section.

### User stories to cover
- As a phone user, I want my sessions grouped by repository so I can find the right one quickly.
- As someone with many sessions, I want collapsed groups that still surface active and newest work.
- As a user starting work, I want to create a session at a typed path, a browsed directory, or in a fresh worktree without leaving the dashboard.
- As a user cleaning up, I want to archive one session or all inactive sessions, undo a delete, and restore from archive or trash.
- As a user returning later, I want stopped sessions to still appear with their names.

### Wireframes (SVG, no screenshots)
- Series of screens: dashboard phone, dashboard wide (cards/rail), new-session sheet, archived/trash view.
- Decision-flow diagram: find session -> open/stop/wake, and create -> typed/browse/group+/worktree, plus archive vs delete vs undo.

### Technical notes (port-relevant only)
- Where grouping and state come from (JSONL headers, session index, hub process state), the idle-detach boundary, and the park/resume behaviour when switching away from a live session.
- Which REST routes back the dashboard and which verbs stay socket-driven.
- Device-local settings storage and the collapsed-group visibility rule.

### Sources to read
`src/client/dashboard*.js`, `sessionGroups.js`, `sessionView.js`, `sessionInfo.js`, `tree.js`, `directoryPicker.js`, `list.css`, `src/hubStore.ts`, `src/hubSession.ts`, `src/sessionIndex.ts`, `src/server.ts`, `ui_work/UI_WIDGET_BREAKDOWN.html` (dashboard sections), `README.md` "What works today".

### Acceptance
- Every dashboard widget in `ui_work/UI_WIDGET_BREAKDOWN.html` is accounted for in a user story or a one-line "not a feature" note.
- Phone and wide layouts are both described; wide layout is described as adding information, not stretching a column.
- SVG wireframes are readable at 390 and 1280 px and carry no screenshots.
- Section is 1,500-2,500 words with a 3-5 line summary and its own TOC.
- `npm run check` is green (docs-only changes must not break it).

### Constraints
User-centric language first. Technical notes stay in their own subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/10-dashboard-sessions.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

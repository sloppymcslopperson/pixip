---
area: extension-ui
part: inventory
project: feature-inventory
---

Capture how Pi extension requests reach the user and how they are answered: blocking dialogs, the inline panel surface, A2UI panels, timeouts, replay and re-ask. This is the main intersection between Pi plugins and the phone UI.

### Goal
An inventory reader should understand every shape an extension request can take, how the user answers it, and what happens when the browser is closed or a request times out.

### Scope
- Blocking `select`, `confirm`, `input`, `editor` dialogs as a bottom sheet, with validation and cancellation.
- `notify` as a toast; non-blocking status feedback.
- Inline panel surface between transcript and composer: expanded/collapsed, composer hidden, draft preserved, one request at a time, Replace banner for a queued second request, fallback card when no renderer or a payload throws.
- A2UI v1.0 panels: lazy-loaded vendored renderer, opaque payload forwarding, surface id discovery, in-panel title suppression, and the no-panel-renderer fallback.
- Pending-UI cache and replay on reattach; answered panels dropped, unanswered replayed before snapshot.
- Timeout ownership: 5 hours detached, 10 hours attached, 0 disables; agent YES/NO re-ask prompt; recorded re-ask cards; `awaitingUser` status and header/dashboard dot.
- `more-time` and re-ask actions; read-only re-ask card that asks the agent to reissue the call.

### User stories to cover
- As a user, I want an extension's question to appear inline without covering my transcript or losing my draft.
- As a user, I want to answer a select/confirm/input/editor from my phone and see it travel back to the extension unchanged.
- As a user who closed the browser, I want unanswered questions to be waiting when I return.
- As a user, I want a timed-out request to be offered again rather than silently lost.
- As an extension author, I want A2UI payloads rendered faithfully even though the hub never parses them.

### Wireframes (SVG, no screenshots)
- Series of screens: sheet dialog, inline panel expanded/collapsed, Replace banner, A2UI panel, re-ask card, timeout notice.
- Decision-flow diagram: request arrives -> blocking or notify -> attached vs detached -> answer/cancel -> timeout -> re-ask -> reissue.

### Technical notes (port-relevant only)
- `extension_ui_request` / `extension_ui_response` passthrough, the `panelHost` boundary, and why the hub never parses A2UI.
- Where pending requests and timed-out records live, and how replay interacts with the snapshot.
- Timeout ownership in the hub, not the client or extension.

### Sources to read
`src/client/surface*.js`, `panelHost.js`, `a2ui.js`, `sheetShell.js`, `sheets.js`, `src/pendingReask.ts`, `src/hub*` pending-UI paths, `src/wire.ts`, `ARCHITECTURE.md` (inline panel surface, A2UI), `pi-host/README.md` (`panel`).

### Acceptance
- Sheet dialogs, notify, inline panels, A2UI, replay, timeouts and re-ask each have a story and edge case.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/40-extension-ui.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

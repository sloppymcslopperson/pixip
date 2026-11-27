---
area: compile-report
depends_on: "dashboard-sessions,transcript-reading,composer-input,extension-ui,bundled-extensions,inbox-reports,worktrees,refs,session-control,daemon-cli,host-protocol,dev-tooling"
part: compile
project: feature-inventory
---

Compile the twelve area inventories into one readable report with a short front index and a self-contained HTML version delivered through the pixip inbox. This ticket also owns the completeness audit and the final quality pass, so it runs last.

### Goal
A reader with low context should be able to open one index, understand the whole product in a few minutes, and jump to any area without reading the code or the old docs.

### Scope
- Assemble `docs/feature-inventory/index.md`: purpose, how to read, one-paragraph product summary, logical groupings, full TOC, and a coverage matrix (area -> surfaces -> source modules).
- Review all twelve area docs for overlap and contradictions; dedupe worktrees/refs/inbox/session-control cross-references instead of repeating them.
- Build the HTML report with `inbox_report` (self-contained, inline SVG, no JavaScript, local assets only, sandbox-safe) and send it with `inbox_send` as a `reports` purpose message.
- Completeness audit against the code: every client module, REST route, CLI verb, bundled extension, wire frame, and widget-breakdown entry is either covered or intentionally marked out of scope with a reason.
- Quality pass: no screenshots, every image an SVG wireframe, each area within the word cap, summaries and TOCs present, phone-readable at 390 px and sane at 1280 px with no horizontal overflow.
- Final `npm run check` and a short "what changed / what was assumed" note in the report.

### User stories to cover
- As the owner, I want a single index I can skim in a few minutes and use to jump into any area.
- As a rewrite planner, I want a coverage matrix that shows nothing was missed.
- As a reader on my phone, I want the HTML report to scroll comfortably with working diagrams and no remote dependencies.
- As a future maintainer, I want the Markdown source to stay the canonical version.

### Wireframes (SVG, no screenshots)
- Series of diagrams: report navigation map (index -> groupings -> areas), and the coverage-matrix legend. These are about reading the report, not the app.

### Technical notes (port-relevant only)
- None beyond a short note on where the report lives and how to regenerate it. This ticket is editorial.

### Sources to read
All twelve area docs, `docs/`, `README.md`, `ARCHITECTURE.md`, `ui_work/UI_WIDGET_BREAKDOWN.html`, the route/CLI/module lists, and the completed area tickets.

### Acceptance
- `docs/feature-inventory/index.md` exists with summary, TOC and coverage matrix.
- All twelve area docs are linked and mutually consistent.
- HTML report renders in pixip with inline SVGs, no JavaScript, no external loads, no screenshots.
- 390 px has no horizontal overflow; 1280 px still reads well.
- Every module/route/CLI verb/extension/wire frame is covered or explicitly out of scope.
- `npm run check` is green.

### Constraints
Editorial only; do not re-implement features. No screenshots. No port verdicts beyond the descriptive rewrite notes already in area docs.

### Output

Write `docs/feature-inventory/index.md`, then build the HTML report with `inbox_report` (suggested report name `feature-inventory`) and send it with `inbox_send` as purpose `reports`. Keep the Markdown index canonical and link every area file by its exact path. Read the area files from disk; do not rewrite their content unless fixing an inconsistency noted in the audit.

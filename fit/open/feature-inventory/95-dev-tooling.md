---
area: dev-tooling
part: inventory
project: feature-inventory
---

Capture the development and operation tooling that is part of the product's workflow: hot reload, watch mode, the test and browser-check harness, static gates, and the architecture/parity docs. This is a process area, not a user-facing feature set, so it is written as a short appendix with explicit "keep or redesign" pressure points.

### Goal
An inventory reader should know which developer guarantees exist today and which ones a rewrite must reproduce or consciously drop.

### Scope
- Hot reload: `--watch`, header `reload` / `/reload`, soft refresh (assets, command policy, session index) without touching live children, and `/pixup-restart` replacing the process while the live set survives.
- Reload mechanics that a port may discard: generation-tagged imports, `module.register`, pause/resume, watch debouncing.
- Test harness: `--data-dir` isolation, fast vs full suites, parallel static gates, `tools/browser-check.mjs`, `tools/shot.mjs`, client-import cycle guard, workspace checks.
- Static gates: `tsc`, ESLint, Prettier code-only formatting, docs formatting on demand.
- Docs as contracts: `ARCHITECTURE.md`, `docs/TUI-parity.md`, `docs/reftags.md`, `ui_work/UI_WIDGET_BREAKDOWN.html`.
- The known "not yet" list: theme tokens, input history, `@file` completion, virtualised transcript, auth.

### User stories to cover
- As a developer, I want CSS/JS edits to appear without restarting the daemon.
- As a developer, I want a restart that keeps my live sessions.
- As a reviewer, I want one command that proves types, lint, formatting, tests and the main browser flows.
- As a rewrite engineer, I want to know which tooling is product-critical and which is Node-specific scaffolding.

### Wireframes (SVG, no screenshots)
- Series of diagrams: reload decision tree (asset vs config vs daemon), test gate pipeline, dev inner loop.
- Decision-flow diagram: what reload when; full check vs fast check.

### Technical notes (port-relevant only)
- Node-only reload internals that the port may replace, and the user-visible contract to keep.
- Isolation rules for tests and the no-build-step client constraint.
- Which docs are the source of truth for numbers and parity.

### Sources to read
`src/reload/*`, `tools/*`, `package.json`, `ARCHITECTURE.md` reload sections and measured latency, `docs/TUI-parity.md`, `ui_work/UI_WIDGET_BREAKDOWN.html`, `README.md` checking the layout.

### Acceptance
- Reload, watch, restart, tests, browser checks and static gates are all covered.
- Product-critical vs Node-specific tooling is explicitly separated.
- Known gaps are listed as gaps, not features.
- SVG diagrams show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
Appendix tone. User-centric framing where a human benefit exists; otherwise a clear developer story. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/95-dev-tooling.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user and developer stories, inline SVG diagrams, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

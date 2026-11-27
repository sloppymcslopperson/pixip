---
area: session-control
part: inventory
project: feature-inventory
---

Capture the per-session controls and derived information a user relies on: model and thinking level, the status footer, renaming and auto titles, tree/fork/clone/import/export, copy, compaction and new/resume. These are the operations that change what a session is, not how it is read.

### Goal
An inventory reader should understand every control that changes a session's configuration or identity, and what information the footer always shows.

### Scope
- Model picker and thinking-level picker from the footer, including queries and availability.
- Status line/footer: pwd, branch, session name, token totals, cost, context usage with thresholds, and `model • thinkingLevel`; add-on widgets are owned by the extensions section.
- Rename (manual wins) and first-prompt auto titles, including the title model override and local fallback.
- Copy last assistant text.
- Read-only session tree, fork, clone, import a JSONL, and export HTML/JSONL.
- `/new`, `/resume`, `/compact` and compaction notices; cancel-compaction is an open ticket, so describe the desired state and cross-link it.
- Stop/wake semantics only as they affect session control (dashboard owns the entry points).

### User stories to cover
- As a user, I want to switch model or thinking level for this session only, from the footer.
- As a user, I want to see cost, tokens, context usage, branch and model at a glance without opening a sheet.
- As a user, I want the session to get a sensible short name from my first prompt, and I want my manual rename to win.
- As a user, I want to copy the agent's last answer, browse the session tree, fork or clone, and export a session.
- As a user, I want to compact a long session and understand what happened to the old history.

### Wireframes (SVG, no screenshots)
- Series of screens: footer anatomy, model/thinking picker, rename, session tree, export/import confirmation.
- Decision-flow diagram: rename -> auto vs manual; new/fork/clone/import -> re-key; compact -> replace history.

### Technical notes (port-relevant only)
- Which controls are RPC built-ins vs client-only, where re-keying happens on new/fork/clone/import, and how the footer values are sourced.
- Title generation as a separate one-shot call, with its fallback and override.
- Compaction's effect on the client window and the `replace` snapshot.

### Sources to read
`src/client/footer.js`, `sessionInfo.js`, `tree.js`, `commands.js`, `src/titles.ts`, `src/commands.ts`, `src/hub*.ts`, `README.md` what works, `docs/TUI-parity.md`, `ARCHITECTURE.md` (status line, built-ins, titles), open `10-cancel-compaction`.

### Acceptance
- Every footer field and per-session control is covered.
- Rename, title fallback, fork/clone/import/export and compaction each have a story and edge case.
- Open gaps are cross-linked rather than described as shipped.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/80-session-control.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

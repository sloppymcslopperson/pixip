---
area: reporting
origin: feature-inventory-grill
project: feature-inventory
---

Add Mermaid diagram support to the inbox HTML report tool and the history Markdown renderer, so reports and transcript history can show flow diagrams without hand-built SVG. This is a standalone follow-up from the feature-inventory grill, not part of the inventory itself.

### Goal
An agent or user can write a Mermaid block in a report or a Markdown transcript, and it renders as a diagram on phone and desktop while keeping the current no-agent-JavaScript sandbox.

### Scope
- Decide where Mermaid runs: vendored, lazily loaded client module vs pre-rendered SVG at report write time.
- `inbox_report` validation: allow fenced ```mermaid blocks and a safe diagram element without opening the sandbox to arbitrary script.
- History Markdown renderer (`src/client/markdown.js` path): render Mermaid in transcript messages, with a sane fallback to code text while loading or on error.
- Asset/licensing and bundle-size budget for the vendored renderer; no external CDN at runtime.
- Tests for fenced-block detection, sanitisation, fallback, and CSP/sandbox compatibility.
- Docs: what diagram syntax is supported and what is deliberately not.

### User stories to cover
- As a report author, I want a flow chart to render from a Mermaid block instead of hand-building SVG.
- As a transcript reader, I want a diagram in agent output to render or degrade to readable text.
- As a security-conscious operator, I want Mermaid not to become an arbitrary-script escape hatch in reports.

### Wireframes (SVG, no screenshots)
- One SVG decision flow: Mermaid block detected -> sanitise -> render locally -> success or fallback to code.

### Technical notes (port-relevant only)
- The report sandbox rules (no JS, no iframes, no external loads) are the hard constraint.
- Pre-render vs client-render trade-off, and the size budget for a vendored renderer.

### Sources to read
`src/inboxReport.ts`, `src/client/markdown.js`, `extensions/pixip-inbox/README.md`, the report tool docs, existing vendored-asset pattern in `src/client/vendor/`.

### Acceptance
- Mermaid blocks render in both report and transcript paths, or fall back cleanly.
- No external runtime fetch and no agent-supplied JavaScript.
- Tests cover detection, sanitisation and fallback; `npm run check` is green.
- Phone/desktop check at 390 and 1280 px for a sample diagram.

### Constraints
Do not weaken the report sandbox. Prefer vendoring and lazy loading over a CDN. This is a backlog item; do not pull it into the inventory tickets.

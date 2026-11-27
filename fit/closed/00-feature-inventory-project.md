---
grilled: true
---

An inventory of every pixip feature for the upcoming top-down rewrite, written as high-level user stories and grouped into an area report. The umbrella ticket owns the plan and the grilling record; the area tickets under `open/feature-inventory/` carry the writing, and `99-compile-report` assembles the final Markdown and HTML report.

### Original request

- Need an inventory of every feature in this app.
- Planning a top-down rewrite in a language yet to be determined; none of the old project's code will be reused.
- A new shell will be designed from scratch in Figma.
- Not every feature will make the port, and some will change.
- Descriptions should be high-level, in the form of short user stories and user-centric statements, rather than technical details. Technical details, where very relevant, belong in a separate, distinct part of the section.
- The report must be consumable with a low context window: formatted like a report with an appropriate table of contents and logical groupings.
- If the work needs multiple parts, create multiple FIT tickets under `open/feature-inventory/` covering areas that fit an agent's coherence window, with the final ticket compiling the report.
- Any images must be wireframes describing workflows, not screenshots.

### Grilling answers (2026-11-27)

Decisions recorded before the split; these apply to every child ticket.

- **Scope:** everything. User-facing web UI, CLI and daemon lifecycle, bundled extensions, Pi host boundary, worktrees and refs, plus dev tooling (reload/watch, test harness, format/lint gates, architecture docs).
- **Grouping:** by feature area, end-to-end across UI/CLI/REST. A cross-cutting area (worktrees, refs) is one section, not repeated per surface.
- **Deliverable:** Markdown under `docs/feature-inventory/` (index plus one file per area), then a compiled, self-contained HTML report sent through the pixip inbox.
- **Port view:** purely descriptive. No keep/change/drop verdicts; a short "rewrite notes" line only where there is a real porting risk or coupling.
- **Technical depth:** port-relevant only (data source, state ownership, protocol/latency coupling), kept in a clearly separate part of each section.
- **Wireframes:** hand-built inline SVG only, never screenshots. Each area gets a series of screens plus a decision-flow diagram for the key workflows.
- **Length:** each area doc capped at roughly 1,500-2,500 words, with a 3-5 line summary and its own TOC; split further if it overflows.
- **Mermaid:** not part of this inventory. A standalone post-inventory ticket for Mermaid support in the inbox report tool and the history Markdown renderer is filed at `backlog/70-mermaid-report-support.md`.

### Split

The plan is the thirteen child tickets listed below. They are ordered by filename priority; `99-compile-report` runs last.

| Ticket | Area |
| --- | --- |
| `10-dashboard-sessions` | Dashboard, grouping, create/archive/delete, settings |
| `20-transcript-reading` | Streaming, thinking, tools, images, long-history reading |
| `30-composer-input` | Compose/send/steer, attachments, commands, bash, policy |
| `40-extension-ui` | Dialogs, inline panels, A2UI, replay, timeouts, re-ask |
| `50-bundled-extensions` | Questionnaire, inbox tool, show-image, add-on widgets |
| `60-inbox-reports` | Inbox messages, page, filters, reply, HTML reports |
| `70-worktrees` | Worktree lifecycle across dashboard, REST and CLI |
| `75-refs` | Ref grammar, chips, resolution, CLI |
| `80-session-control` | Model/thinking, footer, titles, tree/fork/export, compaction |
| `85-daemon-cli` | Daemon lifecycle, restart, data-dir, backend, bind posture |
| `90-host-protocol` | Pi host, RPC/wire contract, replay and re-key guarantees |
| `95-dev-tooling` | Reload/watch, test harness, static gates, docs |
| `99-compile-report` | Index, consistency audit, HTML inbox report |

### Assumption

Confirmed with the owner: this umbrella ticket closes once the split is created; the area tickets carry the writing and the final ticket compiles the report. No area writing starts until the owner gives the go-ahead.

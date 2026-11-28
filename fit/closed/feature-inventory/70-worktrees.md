---
area: worktrees
part: inventory
project: feature-inventory
commit: "882e377"
---

Capture worktrees and repository groups end-to-end: creating a session in a new worktree, joining or switching to an existing one, grouping sessions by repo/worktree, and removing or pruning trees. This area spans dashboard, REST and CLI and is described once rather than per surface.

### Goal
An inventory reader should understand the worktree lifecycle and how it changes session grouping, without needing to read the old implementation.

### Scope
- Repository groups and peers: how sessions are grouped by repo and worktree, group headers, and peer discovery.
- Create a session `new with worktree`, including branch/base naming and location.
- Join or switch to an existing worktree from the dashboard picker and from a group's `+`.
- Remove and prune worktrees, including the force path and confirmation.
- CLI verbs for worktree create/list/remove/prune and their parity with the dashboard.
- REST routes for worktree discovery and removal, and their bind-address posture.
- Interaction with session archive/delete and with the directory picker's home fence.

### User stories to cover
- As a user, I want to start work in a fresh worktree without typing git commands.
- As a user with several worktrees, I want sessions grouped by the tree they belong to so I can tell them apart.
- As a user, I want to join an existing worktree or switch to it from the dashboard.
- As a user, I want to remove or prune a worktree with a clear confirmation and a force option when needed.
- As an operator, I want the same worktree actions from the CLI.

### Wireframes (SVG, no screenshots)
- Series of screens: grouped dashboard with worktree headers, new-with-worktree form, picker/join list, remove/prune confirmation.
- Decision-flow diagram: create -> existing repo vs new repo; remove -> clean vs dirty -> force or abort.

### Technical notes (port-relevant only)
- Worktree identity vs repository identity, how grouping is derived, and where paths are fenced.
- Which operations are idempotent and which need a clean-tree check.
- The REST/CLI split and the bind-address rule for admin verbs.

### Sources to read
`src/worktree.ts`, `src/hubWorktree.ts`, `src/client/dashboardWorktree.js`, `src/client/tree.js`, `src/server.ts`, `README.md` worktrees, `ARCHITECTURE.md` worktrees/repo groups/peers, worktree tests.

### Acceptance
- Create, join/switch, group, remove and prune each have a story.
- Dashboard, REST and CLI coverage is explicit and not duplicated.
- Dirty-tree/force and archive interaction are documented.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/70-worktrees.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

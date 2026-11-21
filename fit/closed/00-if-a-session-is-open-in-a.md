---
grilled: true
commit: "8f1079d"
---

if a session is open in a git repo, show the branch name on the dashboard

### Decisions

- **Placement:** on each cwd group header, beside the home-shortened path. One branch per repo/group; not repeated on every session row.
- **Detection:** the hub runs `git -C <cwd> rev-parse --abbrev-ref HEAD` for distinct cwds and includes `branch` in the sessions frame. Results are cached per cwd so list refreshes do not repeat git work; invalidate when a different cwd appears or a session is created/renamed.
- **Edge cases:** use git's own cwd resolution, so subdirectories, worktrees and submodules show the nearest enclosing repo. Hide the branch entirely when git fails or the path is not a repo. `detached` HEAD shows the abbreviated SHA rather than a branch name.
- **Presentation:** a small chip on the group header, visually secondary to the path and count; it must not widen or stretch the mobile layout.
- **Data path:** additive `branch?: string` on the existing session info/sessions frame; no new REST endpoint and nothing on the streaming event path.
- **Files:** `src/hub.ts`, `src/client/app.js`, `src/client/render.js` (if grouping/labels live there), `src/client/style.css`, `test/title-hub.test.ts` or a focused hub test, and the session-list section of `ARCHITECTURE.md`.

### Acceptance

- A dashboard group whose cwd is inside a git repo shows its current branch.
- Non-repo groups and git failures show no chip and no error.
- Subdirectory, worktree and detached-HEAD behavior matches the decisions above.
- `npm run check` is green and responsive behavior is checked at 390 and 1280.

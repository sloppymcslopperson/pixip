---
project: pixip
---

The dashboard needs hierarchical repo and worktree groups, `new` / `new with worktree` creation, a peer notice, and a safe way to delete a worktree from the UI.

### Design reference

All product decisions are in `backlog/60-worktrees-for-aoe-parity.md` (`### Grilled decisions` and `### Amendment`). This is the client and REST half; the hub primitives are `open/60-worktree-create-join.md`, docs are `open/62-worktree-cli-docs.md`.

### Scope

- `src/client/sessionGroups.js`: hierarchical grouping. A parent repo group owns direct main-repo sessions and one child group per worktree, labelled with its branch; a session discovered manually in a worktree synthesizes the parent group when none exists yet. Keep the pure functions testable (`test/sessionGroups.test.js`).
- Top new-session form gets two submit buttons, `new` and `new with worktree`. A confirm step prefills the branch slug (editable) and states the resulting directory and branch; collisions get a suggested suffix.
- Group `+` menus: parent repo group has `new` and `new with worktree`; worktree group has `new` and `delete`. `new` reuses the group cwd with no git mutation.
- Peer notice: a dismissible notice naming the other live agent(s) in the same cwd, shown on create/open and when a peer appears in an open session, with a tap to open the peer. One notice per session, not per peer.
- New `src/client/dashboardWorktree.js`: worktree manage/delete sheet backed by `GET /api/worktrees` and `DELETE /api/worktrees`. Deleting a referenced worktree is refused with its sessions listed and links to their actions; dirty trees need a danger confirm plus `delete anyway` with the changed-file count; external worktrees are never removed.
- Server routes `GET /api/worktrees` and `DELETE /api/worktrees` (loopback-only, like other process verbs) backed by hub list/remove functions.
- Wire the new client module through `app.js`/`configure` seams and update `tools/check-client-imports.mjs` (the guard rejects feature-to-feature imports).

### Acceptance

- A repo with main-repo and worktree sessions renders one parent group with child worktree groups; a manually opened worktree session appears under a synthesized parent.
- `new with worktree` creates the tree from the form, and a worktree group's `new` creates another agent in place.
- Worktree delete confirms, refuses while sessions reference it (linking to them), and removes a clean pixip-created worktree after confirmation.
- Peer notice appears for two agents in any shared directory and links to the peer.
- Responsive contract holds: one asset set, no duplicated markup, checked at 390 and 1280.

### Tests

- Pure grouping/action-availability tests in `test/` (main repo vs worktree vs non-repo).
- Hub/route tests for worktree list, reference counts, refused delete, dirty force, external refusal.
- `tools/browser-check.mjs` flow for the two buttons, group menu, worktree sheet and delete confirm at 390x844 and 1280x900; `tools/shot.mjs` at both sizes.
- `npm run check` green.

### Grilling

Further grilling is welcome and often necessary for UI copy, menu ordering, and delete-sheet flow. Product decisions in the parent ticket are settled.

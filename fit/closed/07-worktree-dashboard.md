---
project: pixip
grilled: true
---

The dashboard needs hierarchical repo and worktree groups, `new` / `new with worktree` creation, a peer notice, and a safe way to delete a worktree from the UI.

### Design reference

All product decisions are in `backlog/60-worktrees-for-aoe-parity.md` (`### Grilled decisions` and `### Amendment`). This is the client and REST half; the hub primitives are `open/06-worktree-create-join.md`, docs are `open/08-worktree-cli-docs.md`.

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

### Grilled answers (2026-11-21)

- **Peer notice placement:** inline, non-persisted banner at the top of the transcript.
- **Peer dismissal:** once per session. Dismissing hides the notice for the rest of that open session, even if the peer set changes.
- **Worktree slug prefill:** derive from the cwd basename, lowercase, replace invalid runs with `-`, trim leading/trailing punctuation; collisions suggest `-2`, `-3`, …
- **Hierarchy counts/collapse:** the parent repo group counts all descendant sessions; collapsing the parent hides its direct rows and worktree child groups.
- **Delete references:** every listed session (stopped or live) whose `worktree.path` matches blocks deletion and is linked from the refusal; archived/trash sessions do not block.
- **Group menu:** anchored popover at `+`, not a sheet. Parent repo group: `new` + `new with worktree`; worktree group: `new` + `delete`.
- **Main-repo identification:** extend the hub's `SessionInfo`/index with the main repo root for repo sessions (not just worktrees), so direct main-repo sessions are grouped under the correct parent. This is an additive metadata change even though the ticket was scoped client/REST.
- **Worktree API:** required `GET /api/worktrees?cwd=<repo-or-worktree-path>` for the list, and `DELETE /api/worktrees` with the create-shaped JSON body `{ cwd, worktree: { branch }, force? }` for removal. Both loopback-only.
- **External trees:** `pixipActive: false` trees are reported but never removed, including with force.

### Implementation (2026-11-21)

- Hub: `src/worktree.ts` now exposes `detectRepo`; `repo` is persisted on `SessionInfo`/`SessionIndexRecord` and filled for older rows during list. New `src/hubWorktree.ts` adds `listWorktrees`/`removeWorktree` with referenced, dirty and external refusals; `Hub` exposes both.
- Routes: loopback-only `GET /api/worktrees?cwd=` and `DELETE /api/worktrees` (JSON create-shaped body). Structured 409 bodies carry `reason` and, for references, the blocking sessions.
- Client: hierarchical `groupSessionTree`, anchored group menus, two top-form buttons, editable worktree confirm with slug suffixing, and `dashboardWorktree.js` manage/delete sheets. Peer notice is an inline transcript banner dismissed once per open session, with per-peer open links.
- Tests: grouping/slug tests in `test/sessionGroups.test.js`, hub list/remove and dirty/external/reference tests in `test/worktree-hub.test.ts`, REST route tests in `test/worktree-routes.test.ts`, plus the new browser flow.
- `npm run check` is green with `PIXIP_INSIDE`/`PIXIP_SESSION_ID` unset; the browser flow ran as a skip because `PIXIP_CHROME` is not set on this box, so the 390/1280 screenshot pass still needs a Chrome-equipped environment.

### Verification update (2026-11-21)

- Chrome was found under `/tmp/pixip-chrome/...`; with `LD_LIBRARY_PATH=/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu`, `PIXIP_CHROME=... npm run check:browser` passed both 390x844 and 1280x900 viewports.
- `tools/shot.mjs` was run against a temporary repo with main, peer and worktree sessions at both sizes: no horizontal overflow, no page/console problems. At 390 the narrow form keeps `new with worktree` on one line.
- The browser-check flow now clicks list rows/buttons in-page where a live `sessions` frame can replace the element, and filters only the expected `/api/worktrees` 409 resource log.

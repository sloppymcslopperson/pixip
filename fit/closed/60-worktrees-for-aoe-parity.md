---
grilled: true
---

Replacing AoE needs worktree creation and teardown per session, which pixip does not do at all yet.

### Notes

- Decide whether the hub shells out to `git worktree` or reuses AoE's helpers.
- Needs a story for branch naming, cleanup on stop, and refusing two sessions on one worktree.

### Grilled decisions (2026-11-23)

- **Non-goal: sandboxing.** A worktree is parallel working directories, not isolation. Agents share the user, the network and the rest of the filesystem; isolation is the admin's job (container, or a remote VPS like the one this runs on). Document this explicitly instead of implying otherwise.
- **Location:** `<repo-parent>/pixip_worktrees/<repo-name>/<worktree-name>` (e.g. `/home/me/proj` -> `/home/me/pixip_worktrees/proj/fix-reconnect`).
- **Name + branch:** the directory name is the branch slug; the branch is `pixip/<slug>`, created from the repo's current HEAD, no fetch. The slug is prefilled and editable in a small confirm step; no separate worktree-name field.
- **Create surfaces:** the top new-session form has two submit buttons, `new` and `new with worktree`. A main-repo group's `+` menu has `new` and `new with worktree`. A worktree group's `+` menu has `new` and `delete` (delete opens a confirm modal).
- **Join an existing worktree:** the worktree group's `new` creates another agent in that same worktree with no git mutation. The hub detects worktrees by cwd, so an agent opened manually at a worktree path gets the metadata too and lands in the right group.
- **Dashboard grouping:** hierarchical. A parent repo group owns direct main-repo sessions and one child group per worktree (labelled with its branch). A worktree discovered from a manual path gets a synthesized parent group when none exists yet.
- **Multiple agents per worktree:** allowed, with a dismissible notice naming the other live agent. No hard refusal.
- **Teardown:** never automatic. Stop, archive and delete leave worktrees alone; removal is explicit from the worktree group's `delete` (and later the CLI).
- **Delete safety:** deleting a worktree with sessions still referencing it is refused, listing those sessions and linking to their stop/archive/delete actions. A dirty worktree needs a normal danger confirm plus an explicit `delete anyway`; changes are shown as a count. External worktrees (`createdByPixip: false`) are never removed by pixip, even with force.
- **Split at execution:** three tickets: (a) create/join + metadata, (b) dashboard hierarchy + create/delete surfaces, (c) CLI + docs. First slice is what enables parallel work.

### Remaining assumptions

- The worktree base directory is computed per repo, not configured; it can join the options TOML later (`open/60-options-toml-defaults.md`).
- Slug collisions (branch or directory already exists) are resolved by a suggested suffix in the confirm step.
- If a worktree directory disappears, attach fails visibly; there is no silent fallback to the repo root.

### Amendment (2026-11-23): peers are a directory property, not a worktree one

The multi-agent rule generalizes to every session, not only worktrees:

- **Any cwd can have several live agents.** Creating or opening a session whose realpath cwd already has a live session is allowed, with the same dismissible notice naming the other agent(s), plus a tap to open the peer.
- The hub compares live sessions by realpath cwd and exposes the peer list on `SessionInfo` (e.g. `peers: [{ id, name }]`), refreshed on create/stop/archive so an attached session learns when a peer starts or leaves.
- Worktrees are just the case where the shared directory happens to be a linked worktree. There is no worktree-specific duplicate guard and no `createdByPixip` role in the sharing rule.
- If a peer notice is shown on create, it is also shown when a second agent appears in the cwd of a session that is already open (via the refreshed peer list, not a new socket frame per event).
- Sharing a single directory means agents can overwrite each other's files. That is documented as expected, the same way it is documented that worktrees do not isolate.
- Tests: two sessions in one plain directory (no git) are allowed and see each other's names; the worktree case reuses the same code path.

### Split

This ticket is the design record. Implementation is tracked in:

- `open/60-worktree-create-join.md` — hub worktree module, create/join, metadata, peers, tests
- `open/61-worktree-dashboard.md` — hierarchical groups, create buttons/menus, peer notice, delete flow, REST
- `open/62-worktree-cli-docs.md` — CLI verbs, ARCHITECTURE/README/TUI-parity docs

Additional grilling is expected on those tickets where implementation gaps remain; the decisions above are settled.

### Status: planning record, closed

This ticket was used for planning only. It is closed because its scope was split into the three implementation tickets listed under `### Split`; further work happens there. Keep it as the record of the grilled decisions, the peer-directory amendment, and the remaining assumptions.

---
project: pixip
grilled: true
---

Add the `pixip worktree` CLI verbs and document the worktree model, its lifecycle, and the deliberate non-goal of sandboxing.

### Design reference

Decisions are in `backlog/60-worktrees-for-aoe-parity.md`. CLI and docs only; creation is `open/06-worktree-create-join.md`, UI is `open/07-worktree-dashboard.md`.

### Scope

- `bin/pixip.ts`: `pixip worktree list` (repo, path, branch, owner, live agent count, dirty state), `pixip worktree remove <path> [--force]`, `pixip worktree prune [<repo>]`. Reuse the hub/worktree functions; the CLI must not reimplement git logic. Refuse removal while sessions reference the tree unless the explicit override documented in the parent ticket is given; never remove external worktrees.
- `ARCHITECTURE.md`: worktree model and metadata, the hub-shells-git boundary (Rust-port seam), create/join and teardown rules, peer directories, and an explicit "worktrees are not a sandbox" paragraph (isolation is the admin's container/VPS).
- `README.md`: remove worktree creation from "Not yet", document the default location and the CLI, update the relationship-to-AoE paragraph so co-running is about session ownership, not unexplained worktree disagreement.
- `docs/TUI-parity.md`: point the worktree row at the split tickets and mark it done once implemented.

### Acceptance

- `pixip worktree list` answers who is in a worktree without the UI.
- `remove` refuses referenced or dirty trees without `--force`, and never touches `createdByPixip: false` trees.
- Docs describe location, branch naming, create/join, teardown, peer directories, and the non-sandbox boundary.
- No code duplicates git invocation outside `src/worktree.ts`.

### Tests

- CLI/daemon tests in the existing `test/daemon.test.ts`/`test/builtin.test.ts` style for list output and refusal exit codes.
- Docs checked by `npm run format:check`; `npm run check` green.

### Grilling

Further grilling is welcome for CLI flags, exit codes and `--force` semantics. Product decisions in the parent ticket are settled.

### Grilled answers (2026-11-24)

- **Data source:** daemon first. When the data-dir daemon is running, use `GET /api/worktrees` plus `GET /api/sessions`; otherwise instantiate the `Hub` over the same data-dir (with startup trash cleanup skipped) so `list` and safety checks still work offline.
- **Reference override:** never. `--force` only overrides dirty state, matching the dashboard and parent design. Referenced trees (live or stopped) and external `pixipActive: false` trees always refuse. This resolves the earlier conflicting answers in favour of the settled parent rule.
- **Force semantics:** `--force` discards uncommitted changes after the explicit flag; it never bypasses session references or external ownership.
- **Output:** human-readable aligned table by default, plus `--json` for machine-readable output, matching `status --json`.
- **Exit codes:** `0` success; `1` usage/git/daemon errors; `2` safe refusal (referenced, dirty without `--force`, external).
- **Owner column:** `pixip` when `pixipActive` is true, otherwise `external`.
- **Arguments:** `worktree list [<repo-or-path>]` and `worktree prune [<repo-or-path>]` default to cwd; `worktree remove <path>` requires the exact worktree root. Any path inside the repo is accepted for list/prune and resolved to its root.
- **List contents:** repo, path, branch, owner, live agent count, dirty state, and session names/states, so the CLI answers who is in a worktree without the UI.
- **JSON shape:** `{repo, worktrees: [{...WorktreeEntry, owner, liveAgents, sessions: [{id, name, state, live}]}]}`.
- **Prune:** run git's prune for the resolved repo and print `pruned <repo>`; no before/after listing.

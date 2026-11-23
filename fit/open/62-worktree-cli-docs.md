---
project: pixip
---

Add the `pixip worktree` CLI verbs and document the worktree model, its lifecycle, and the deliberate non-goal of sandboxing.

### Design reference

Decisions are in `backlog/60-worktrees-for-aoe-parity.md`. CLI and docs only; creation is `open/60-worktree-create-join.md`, UI is `open/61-worktree-dashboard.md`.

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

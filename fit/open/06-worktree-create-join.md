---
project: pixip
---

Let a session be created in a fresh git worktree, or in any directory or existing worktree that already has live agents, and carry that worktree plus peer information on the session record.

### Design reference

Product decisions are settled in `backlog/60-worktrees-for-aoe-parity.md` (`### Grilled decisions` and `### Amendment`). Implement them; do not reopen them without a reason. This ticket is the create and persistence half; the dashboard and CLI halves are `open/07-worktree-dashboard.md` and `open/08-worktree-cli-docs.md`.

### Scope

- New `src/worktree.ts`: repo root and worktree detection (`git rev-parse --show-toplevel`, `--git-dir` vs `--git-common-dir`), slug validation, directory derivation `<repo-parent>/pixip_worktrees/<repo>/<slug>`, `worktree add -b pixip/<slug> <path> HEAD`, remove/list/dirty/merged checks with a bounded `execFile` git wrapper. No new dependency.
- `hub.create` gains an optional worktree request (`{ branch, base? }` or equivalent) and creates the worktree before spawning Pi; a git failure creates no session and returns the git message verbatim.
- Detection on create and attach: a cwd inside a linked worktree inherits `{ repo, path, branch, createdByPixip: false }` without any git mutation. Manual paths therefore join the right repo and worktree.
- Persist `worktree` on `SessionIndexRecord` (normalize on read, tolerate old records) and expose it on `SessionInfo`.
- Peer list: compare live sessions by realpath cwd, expose `peers: [{ id, name }]` on `SessionInfo` refreshed on create/stop/archive, so another agent in the same directory (plain, repo, or worktree) is visible. Never block a second agent.
- Non-goal: no sandboxing. Worktrees share the user and filesystem; note that wherever the hub documents the feature.

### Files

- `src/worktree.ts` (new), `src/jsonl.ts` only if a helper belongs there
- `src/hubLive.ts` create/attach, `src/hubControl.ts` or `src/hubStore.ts` for metadata and peers, `src/hub.ts` facade
- `src/sessionIndex.ts`, `src/wire.ts`
- `src/server.ts` create handlers (`create` frame and `POST /api/sessions`)

### Acceptance

- A create with a worktree branch produces the directory, branch and session cwd, and the session lists as that worktree.
- A create in an existing plain directory or worktree is allowed even with live agents there, and reports them as peers.
- A manual worktree cwd gets metadata without running `worktree add`; a non-repo worktree request fails with a clear error and no session.
- Worktree and peer metadata survive a daemon restart via the index.
- No behavior change for creates without worktree metadata.

### Tests

- `test/worktree.test.ts`: temp git repo, add/remove/prune, dirty and merged checks, path/slug derivation, non-repo error.
- Hub tests: create-with-worktree, detection/inheritance, index round trip, peers appear and disappear on stop/archive, second agent in one plain cwd allowed.
- `npm run check` green.

### Grilling

Further grilling is welcome and often necessary for implementation gaps (exact git invocation, error shapes, peer refresh timing). The product decisions in the parent ticket are settled; grill only what those do not answer.

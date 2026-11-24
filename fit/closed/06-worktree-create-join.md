---
project: pixip
grilled: true
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

### Grilled answers (2026-11-23)

- **Create request:** `hub.create(cwd, name?, worktree?)` where `worktree` is `{ branch, base? }`. `branch` is the slug, so `branch: "fix-reconnect"` creates directory `.../fix-reconnect` and git branch `pixip/fix-reconnect`. A leading `pixip/` is accepted defensively and stripped for the directory slug.
- **Base:** optional commit-ish, resolved in the main repo root; default is the main repo's current `HEAD` (which may be a feature branch). A bad base returns git's error.
- **Metadata:** `worktree` is `{ repo, path, branch, pixipActive }`. `repo` and `path` are absolute roots; `path` is the worktree root even when the session cwd is a subdirectory; `branch` is the full branch name. Main-repo and non-repo sessions have no `worktree`.
- **Ownership flag:** use `pixipActive` only, not `createdByPixip`. It is true when pixip created the worktree or when a pixip session is/was mounted in it, so pre-existing worktrees used through pixip also count. Delete safety remains ticket 07/08's concern.
- **Peers:** live sessions only, matched by realpath cwd, reciprocal, self excluded. Refreshed on create/stop/archive (and child exit). After a daemon restart there are no peers until sessions are live again; worktree/cwd metadata still persists. A peer's `id` is its stable logical id; `name` falls back to `Untitled session`.
- **Stopped rows:** `hub.list()` takes `worktree` from the index or a live session; JSONL-only rows pick it up on the next attach. No filesystem-wide worktree detection during list.
- **Scratch:** implement the full helper set now: create/add, detect, list, remove with force, prune, dirty count, and merged check (`HEAD` ancestor of main repo `HEAD`).
- **Errors:** git failures surface trimmed stderr (`fatal: ...`) verbatim, without Node's `Command failed:` wrapper.

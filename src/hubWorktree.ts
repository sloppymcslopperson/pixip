// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Worktree management is a thin shell around git plus the session list: git
// owns the trees, the hub only decides whether a tree is safe to remove.
import type { SessionInfo } from "./wire.ts";
import {
	type WorktreeEntry,
	listWorktrees,
	removeWorktree,
	worktreeBranch,
	worktreePath,
	worktreeSlug,
} from "./worktree.ts";

export interface WorktreeListing {
	repo: string;
	/** Main worktree first, then the linked worktrees by branch/path. */
	worktrees: WorktreeEntry[];
}

export interface RemoveWorktreeRequest {
	/** Any path inside the repository; the hub resolves the repo root. */
	cwd: string;
	worktree: { branch: string };
	/** Allow removing a dirty tree. Referenced and external trees stay refused. */
	force?: boolean;
}

export type RemoveWorktreeResult =
	| { removed: true; worktree: WorktreeEntry }
	| { removed: false; reason: "referenced"; worktree: WorktreeEntry; sessions: SessionInfo[] }
	| { removed: false; reason: "dirty"; worktree: WorktreeEntry }
	| { removed: false; reason: "external"; worktree: WorktreeEntry };

export async function list(this: any, cwd: string): Promise<WorktreeListing> {
	const worktrees = await listWorktrees(cwd);
	const repo = worktrees[0]?.repo ?? cwd;
	worktrees.sort((a, b) => {
		const main = Number(b.path === repo) - Number(a.path === repo);
		return main || a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path);
	});
	return { repo, worktrees };
}

export async function remove(this: any, request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
	const cwd = typeof request?.cwd === "string" ? request.cwd : "";
	const branch = typeof request?.worktree?.branch === "string" ? request.worktree.branch : "";
	if (!cwd || !branch) throw new Error("cwd and worktree.branch are required");
	const slug = worktreeSlug(branch);
	const listing = await this.listWorktrees(cwd);
	const full = worktreeBranch(slug);
	const expectedPath = worktreePath(listing.repo, slug);
	const target = listing.worktrees.find(
		(entry) => entry.branch === full || entry.branch === slug || entry.branch === branch || entry.path === expectedPath,
	);
	if (!target) throw new Error(`unknown worktree ${branch}`);

	// The main worktree is the repository itself, and a tree pixip never mounted
	// belongs to the user (or another tool): both are read-only here.
	if (target.path === listing.repo || !target.pixipActive) {
		return { removed: false, reason: "external", worktree: target };
	}

	const sessions = (await this.list()).filter((session) => session.worktree?.path === target.path);
	if (sessions.length > 0) {
		return { removed: false, reason: "referenced", worktree: target, sessions };
	}
	if (target.dirty && request.force !== true) {
		return { removed: false, reason: "dirty", worktree: target };
	}

	await removeWorktree(target.path, { force: request.force === true, repo: listing.repo });
	return { removed: true, worktree: target };
}

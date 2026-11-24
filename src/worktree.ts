// Git worktrees are plain directories plus a git-managed link back to the main
// repo. The hub shells out to git rather than growing its own worktree logic:
// this module is the whole boundary, so the Rust port replaces one file.
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { WorktreeInfo } from "./wire.ts";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,79})$/;
const BRANCH_PREFIX = "pixip/";

export interface CreateWorktreeRequest {
	/** Worktree slug; `fix-reconnect` becomes branch `pixip/fix-reconnect`. */
	branch: string;
	/** Commit-ish resolved in the main repo; defaults to the main repo's HEAD. */
	base?: string;
}

export interface WorktreeEntry {
	repo: string;
	path: string;
	branch: string;
	head?: string;
	bare: boolean;
	detached: boolean;
	dirty: boolean;
	changedFiles: number;
	pixipActive: boolean;
}

interface Repository {
	root: string;
	topLevel: string;
	linked: boolean;
}

interface GitOutput {
	stdout: string;
	stderr: string;
	status: number;
}

function gitError(error: unknown): Error {
	const failure = error as { stderr?: unknown; message?: unknown };
	const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
	return new Error(stderr || (typeof failure.message === "string" ? failure.message : "git command failed"));
}

async function git(cwd: string, args: string[], allowedExitCodes: number[] = []): Promise<GitOutput> {
	try {
		const { stdout, stderr } = await run("git", ["-C", cwd, ...args], {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		});
		return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), status: 0 };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "number" && allowedExitCodes.includes(code)) {
			const failure = error as { stdout?: string; stderr?: string };
			return { stdout: failure.stdout?.trimEnd() ?? "", stderr: failure.stderr?.trimEnd() ?? "", status: code };
		}
		throw gitError(error);
	}
}

/** A real path for peer matching; unresolved paths compare as lexical paths. */
export async function realCwd(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

/** Strip a defensive `pixip/` prefix and validate the directory/branch slug. */
export function worktreeSlug(value: string): string {
	if (typeof value !== "string" || value !== value.trim()) {
		throw new Error(`invalid worktree slug: ${JSON.stringify(value)}`);
	}
	const slug = value.startsWith(BRANCH_PREFIX) ? value.slice(BRANCH_PREFIX.length) : value;
	if (!SLUG.test(slug) || slug.includes("..") || slug.endsWith(".") || slug.endsWith(".lock")) {
		throw new Error(`invalid worktree slug: ${JSON.stringify(value)}`);
	}
	return slug;
}

export function worktreeBranch(slug: string): string {
	return `${BRANCH_PREFIX}${slug}`;
}

/** `<repo-parent>/pixip_worktrees/<repo-name>/<slug>`. */
export function worktreePath(repoRoot: string, slug: string): string {
	const root = resolve(repoRoot);
	return join(dirname(root), "pixip_worktrees", basename(root) || "repo", worktreeSlug(slug));
}

/** Validate the `worktree` field from a create frame or REST body. */
export function normalizeWorktreeRequest(raw: unknown): CreateWorktreeRequest | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("worktree must be an object");
	const request = raw as { branch?: unknown; base?: unknown };
	if (typeof request.branch !== "string") throw new Error("worktree.branch must be a string");
	if (request.base !== undefined && typeof request.base !== "string") {
		throw new Error("worktree.base must be a string");
	}
	worktreeSlug(request.branch);
	return {
		branch: request.branch,
		...(typeof request.base === "string" ? { base: request.base } : {}),
	};
}

async function repository(cwd: string): Promise<Repository> {
	const absolute = resolve(cwd);
	let topLevel: string;
	try {
		topLevel = (await git(absolute, ["rev-parse", "--show-toplevel"])).stdout.trim();
	} catch {
		throw new Error(`not a git repository: ${cwd}`);
	}
	if (!topLevel) throw new Error(`not a git repository: ${cwd}`);

	const gitDir = (await git(topLevel, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
	const commonRaw = (await git(topLevel, ["rev-parse", "--git-common-dir"])).stdout.trim();
	const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(topLevel, commonRaw);
	const linked = resolve(gitDir) !== resolve(commonDir);
	const root = linked && basename(commonDir) === ".git" ? dirname(commonDir) : topLevel;
	return { root: resolve(root), topLevel: resolve(topLevel), linked };
}

async function branchAt(cwd: string): Promise<string> {
	const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (branch && branch !== "HEAD") return branch;
	const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return sha || "HEAD";
}

/** The main repository root for any cwd inside a repo, or undefined outside git. */
export async function detectRepo(cwd: string): Promise<string | undefined> {
	try {
		return (await repository(cwd)).root;
	} catch {
		return undefined;
	}
}

/**
 * Metadata for a cwd inside a linked worktree, or undefined for a main worktree,
 * a non-repo directory, or a path that does not exist. Read-only: no git mutation.
 */
export async function detectWorktree(cwd: string): Promise<WorktreeInfo | undefined> {
	try {
		const repo = await repository(cwd);
		if (!repo.linked) return undefined;
		return {
			repo: repo.root,
			path: repo.topLevel,
			branch: await branchAt(cwd),
			// A mounted session means the worktree is active in pixip, including
			// pre-existing worktrees that were not created by the hub.
			pixipActive: true,
		};
	} catch {
		return undefined;
	}
}

/**
 * Create a worktree from the main repo's current HEAD (or an explicit base), then
 * return the metadata to put on the session. A git failure throws its message
 * unchanged; the caller has not spawned anything yet, so no session exists.
 */
export async function createWorktree(cwd: string, request: CreateWorktreeRequest): Promise<WorktreeInfo> {
	const slug = worktreeSlug(request.branch);
	const repo = await repository(cwd);
	const path = worktreePath(repo.root, slug);
	const branch = worktreeBranch(slug);
	await mkdir(dirname(path), { recursive: true });
	await git(repo.root, ["worktree", "add", "-b", branch, path, request.base?.trim() || "HEAD"]);
	return { repo: repo.root, path, branch, pixipActive: true };
}

/** `git worktree list --porcelain`, enriched with dirty state for each tree. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	const repo = await repository(cwd);
	const { stdout } = await git(repo.root, ["worktree", "list", "--porcelain"]);
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> & { path?: string } = {};
	const flush = async () => {
		if (!current.path) return;
		const path = resolve(current.path);
		const dirty = current.bare
			? { dirty: false, changedFiles: 0 }
			: await dirtyWorktree(path).catch(() => ({
					dirty: false,
					changedFiles: 0,
				}));
		const branch = current.branch ?? current.head?.slice(0, 7) ?? "HEAD";
		entries.push({
			repo: repo.root,
			path,
			branch,
			head: current.head,
			bare: current.bare ?? false,
			detached: current.detached ?? false,
			...dirty,
			// A pixip branch (or the managed directory layout) marks a tree the
			// dashboard can own; sessions can additionally mark any tree active.
			pixipActive: branch.startsWith(BRANCH_PREFIX) || path.startsWith(join(dirname(repo.root), "pixip_worktrees")),
		});
		current = {};
	};
	for (const line of stdout.split("\n")) {
		if (!line) {
			await flush();
			continue;
		}
		const [key, ...rest] = line.split(" ");
		const value = rest.join(" ");
		if (key === "worktree") current.path = value;
		else if (key === "HEAD") current.head = value;
		else if (key === "branch") current.branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
		else if (key === "bare") current.bare = true;
		else if (key === "detached") current.detached = true;
	}
	await flush();
	return entries;
}

/** Count changed files from `git status --porcelain` (tracked and untracked). */
export async function dirtyWorktree(path: string): Promise<{ dirty: boolean; changedFiles: number }> {
	const { stdout } = await git(path, ["status", "--porcelain"]);
	const changedFiles = stdout.split("\n").filter(Boolean).length;
	return { dirty: changedFiles > 0, changedFiles };
}

/** True when the worktree's HEAD is an ancestor of `into` in the main repo. */
export async function isWorktreeMerged(path: string, into = "HEAD"): Promise<boolean> {
	const repo = await repository(path);
	const target = (await git(repo.root, ["rev-parse", into])).stdout.trim();
	const result = await git(path, ["merge-base", "--is-ancestor", "HEAD", target], [1]);
	return result.status === 0;
}

export async function removeWorktree(path: string, options: { force?: boolean; repo?: string } = {}): Promise<void> {
	const repo = options.repo ? resolve(options.repo) : (await repository(path)).root;
	await git(repo, ["worktree", "remove", ...(options.force ? ["--force"] : []), resolve(path)]);
}

export async function pruneWorktrees(cwd: string): Promise<void> {
	const repo = await repository(cwd);
	await git(repo.root, ["worktree", "prune"]);
}

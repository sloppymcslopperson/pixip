import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import {
	createWorktree,
	detectWorktree,
	dirtyWorktree,
	isWorktreeMerged,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	worktreeBranch,
	worktreePath,
	worktreeSlug,
} from "../src/worktree.ts";
import { cleanupRoots, exists, tempRoot } from "./helpers/harness.ts";

const run = promisify(execFile);

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "pixip test",
	GIT_AUTHOR_EMAIL: "pixip@example.invalid",
	GIT_COMMITTER_NAME: "pixip test",
	GIT_COMMITTER_EMAIL: "pixip@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", ["-C", cwd, ...args], { env: GIT_ENV });
	return stdout.trim();
}

async function initRepo(): Promise<{ root: string; repo: string }> {
	const root = await tempRoot("pixip-worktree-");
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-b", "main");
	await writeFile(join(repo, "file.txt"), "one\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-m", "init");
	return { root, repo };
}

after(async () => {
	await cleanupRoots();
});

describe("worktree helpers", () => {
	it("derives and validates the slug, branch and directory", () => {
		assert.equal(worktreeSlug("fix-reconnect"), "fix-reconnect");
		assert.equal(worktreeSlug("pixip/fix-reconnect"), "fix-reconnect");
		assert.equal(worktreeBranch("fix-reconnect"), "pixip/fix-reconnect");
		assert.equal(worktreePath("/home/me/proj", "fix-reconnect"), "/home/me/pixip_worktrees/proj/fix-reconnect");
		assert.throws(() => worktreeSlug("../escape"), /invalid worktree slug/);
		assert.throws(() => worktreeSlug("has space"), /invalid worktree slug/);
		assert.throws(() => worktreeSlug("branch.lock"), /invalid worktree slug/);
	});

	it("creates, detects, lists and removes a worktree", async () => {
		const { repo } = await initRepo();
		const created = await createWorktree(repo, { branch: "fix-reconnect" });

		assert.equal(created.repo, repo);
		assert.equal(created.path, worktreePath(repo, "fix-reconnect"));
		assert.equal(created.branch, "pixip/fix-reconnect");
		assert.equal(created.pixipActive, true);
		assert.equal(await exists(created.path), true);
		assert.equal(await git(created.path, "rev-parse", "--abbrev-ref", "HEAD"), "pixip/fix-reconnect");
		assert.deepEqual(await detectWorktree(created.path), created);
		assert.equal(await detectWorktree(repo), undefined);

		const entries = await listWorktrees(repo);
		assert.ok(entries.some((entry) => entry.path === repo && entry.branch === "main"));
		const linked = entries.find((entry) => entry.path === created.path);
		assert.equal(linked?.branch, "pixip/fix-reconnect");
		assert.equal(linked?.pixipActive, true);
		assert.equal(linked?.dirty, false);

		await writeFile(join(created.path, "untracked.txt"), "x\n");
		assert.deepEqual(await dirtyWorktree(created.path), { dirty: true, changedFiles: 1 });
		await assert.rejects(removeWorktree(created.path), /modified or untracked|use --force/);
		await removeWorktree(created.path, { force: true });
		assert.equal(await exists(created.path), false);
		assert.equal(
			(await listWorktrees(repo)).some((entry) => entry.path === created.path),
			false,
		);
	});

	it("prunes a worktree whose directory disappeared", async () => {
		const { repo } = await initRepo();
		const created = await createWorktree(repo, { branch: "gone" });
		await rm(created.path, { recursive: true, force: true });
		await pruneWorktrees(repo);
		assert.equal(
			(await listWorktrees(repo)).some((entry) => entry.path === created.path),
			false,
		);
	});

	it("reports whether a worktree branch is merged into the main HEAD", async () => {
		const { repo } = await initRepo();
		const created = await createWorktree(repo, { branch: "merged" });
		assert.equal(await isWorktreeMerged(created.path), true);

		await writeFile(join(created.path, "work.txt"), "new\n");
		await git(created.path, "add", "work.txt");
		await git(created.path, "commit", "-m", "worktree commit");
		assert.equal(await isWorktreeMerged(created.path), false);
	});

	it("refuses to create in a non-repository and leaves no directory", async () => {
		const plain = await tempRoot("pixip-worktree-plain-");
		await assert.rejects(createWorktree(plain, { branch: "nope" }), /not a git repository/);
		const expected = join(dirname(plain), "pixip_worktrees", basename(plain), "nope");
		assert.equal(await exists(expected), false);
	});
});

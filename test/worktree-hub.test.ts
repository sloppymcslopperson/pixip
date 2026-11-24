import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import { listWorktrees, worktreePath } from "../src/worktree.ts";
import {
	cleanupRoots,
	exists,
	fixtureRoot,
	hubFor,
	infoEntry,
	records,
	sessionFile,
	tempRoot,
} from "./helpers/harness.ts";

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
	const root = await tempRoot("pixip-worktree-hub-");
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

describe("hub worktrees and peers", () => {
	it("creates a session in a fresh worktree and persists its metadata", async () => {
		const paths = await fixtureRoot("pixip-worktree-hub-");
		const { repo } = await initRepo();
		const hub = hubFor(paths);
		const created = await hub.create(repo, "worktree session", { branch: "fix-reconnect" });
		const expected = worktreePath(repo, "fix-reconnect");

		assert.equal(created.cwd, expected);
		assert.equal(created.worktree?.repo, repo);
		assert.equal(created.worktree?.path, expected);
		assert.equal(created.worktree?.branch, "pixip/fix-reconnect");
		assert.equal(created.worktree?.pixipActive, true);
		assert.equal(await exists(expected), true);
		assert.equal(await git(expected, "rev-parse", "--abbrev-ref", "HEAD"), "pixip/fix-reconnect");

		const [record] = await records(paths);
		assert.deepEqual(record?.["worktree"], created.worktree);
		const listed = (await hub.list()).find((session) => session.logicalId === created.logicalId);
		assert.deepEqual(listed?.worktree, created.worktree);
		await hub.shutdown();

		const restarted = hubFor(paths);
		const persisted = (await restarted.list()).find((session) => session.logicalId === created.logicalId);
		assert.deepEqual(persisted?.worktree, created.worktree);
		assert.equal(persisted?.cwd, expected);
		await restarted.shutdown();
	});

	it("allows several agents in one plain directory and refreshes peers", async () => {
		const paths = await fixtureRoot("pixip-worktree-peers-");
		const cwd = join(paths.dir, "plain");
		await mkdir(cwd, { recursive: true });
		const hub = hubFor(paths);
		const first = await hub.create(cwd, "one");
		const second = await hub.create(cwd, "two");

		const rows = await hub.list();
		let one = rows.find((session) => session.logicalId === first.logicalId);
		const two = rows.find((session) => session.logicalId === second.logicalId);
		assert.deepEqual(one?.peers, [{ id: second.logicalId, name: "two" }]);
		assert.deepEqual(two?.peers, [{ id: first.logicalId, name: "one" }]);
		assert.equal(rows.length, 2);

		await hub.stop(second.id);
		one = (await hub.list()).find((session) => session.logicalId === first.logicalId);
		assert.deepEqual(one?.peers, []);
		assert.deepEqual(one?.worktree, undefined);
		await hub.shutdown();
	});

	it("detects a manually created worktree without running worktree add", async () => {
		const paths = await fixtureRoot("pixip-worktree-detect-");
		const { repo } = await initRepo();
		const manual = worktreePath(repo, "manual");
		await git(repo, "worktree", "add", "-b", "manual-branch", manual, "HEAD");
		const nested = join(manual, "nested");
		await mkdir(nested, { recursive: true });
		const { id } = await sessionFile(paths, [infoEntry("manual")], { id: "01a1fb3f-manual", cwd: nested });
		const hub = hubFor(paths);

		const attached = await hub.attach(id);
		assert.equal(attached.cwd, nested);
		assert.equal(attached.worktree?.path, manual);
		assert.equal(attached.worktree?.repo, repo);
		assert.equal(attached.worktree?.branch, "manual-branch");
		assert.equal(attached.worktree?.pixipActive, true);

		const [record] = await records(paths);
		assert.deepEqual(record?.["worktree"], attached.worktree);
		const entries = await listWorktrees(repo);
		assert.equal(entries.length, 2);
		await hub.shutdown();
	});

	it("refuses a worktree create outside a repository without creating a session", async () => {
		const paths = await fixtureRoot("pixip-worktree-refuse-");
		const plain = join(paths.dir, "plain");
		await mkdir(plain, { recursive: true });
		const hub = hubFor(paths);
		await assert.rejects(hub.create(plain, "nope", { branch: "nope" }), /not a git repository/);
		assert.deepEqual(await hub.list(), []);
		assert.equal(await exists(join(dirname(plain), "pixip_worktrees")), false);
		await hub.shutdown();
	});

	it("creates from an explicit base commit-ish", async () => {
		const paths = await fixtureRoot("pixip-worktree-base-");
		const { repo } = await initRepo();
		await git(repo, "checkout", "-b", "feature");
		await writeFile(join(repo, "feature.txt"), "feature\n");
		await git(repo, "add", "feature.txt");
		await git(repo, "commit", "-m", "feature");
		const featureHead = await git(repo, "rev-parse", "HEAD");
		const hub = hubFor(paths);

		const created = await hub.create(repo, "from feature", { branch: "from-feature", base: "feature" });
		assert.equal(await git(created.cwd, "rev-parse", "HEAD"), featureHead);
		assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
		await hub.shutdown();
	});
});

describe("hub worktree listing and removal", () => {
	it("adds the repo root to main-repo and worktree sessions", async () => {
		const paths = await fixtureRoot("pixip-worktree-repo-");
		const { repo } = await initRepo();
		const hub = hubFor(paths);
		const main = await hub.create(repo, "main");
		const tree = await hub.create(repo, "worktree", { branch: "repo-meta" });
		assert.equal(main.repo, repo);
		assert.equal(tree.repo, repo);
		const rows = await hub.list();
		assert.equal(rows.find((row) => row.logicalId === main.logicalId)?.repo, repo);
		await hub.shutdown();
	});

	it("lists the main tree first and refuses removal while sessions reference it", async () => {
		const paths = await fixtureRoot("pixip-worktree-remove-");
		const { repo } = await initRepo();
		const hub = hubFor(paths);
		const session = await hub.create(repo, "referenced", { branch: "remove-me" });
		const listing = await hub.listWorktrees(repo);
		assert.equal(listing.repo, repo);
		assert.equal(listing.worktrees[0]?.path, repo);
		const target = listing.worktrees.find((entry) => entry.branch === "pixip/remove-me");
		assert.ok(target);
		assert.equal(target.dirty, false);

		const refused = await hub.removeWorktree({
			cwd: repo,
			worktree: { branch: "remove-me" },
		});
		assert.equal(refused.removed, false);
		if (!refused.removed) {
			assert.equal(refused.reason, "referenced");
			assert.deepEqual(
				refused.sessions.map((row) => row.logicalId),
				[session.logicalId],
			);
		}
		assert.equal(await exists(session.cwd), true);
		await hub.shutdown();
	});

	it("removes a clean tree after its sessions are archived", async () => {
		const paths = await fixtureRoot("pixip-worktree-clean-");
		const { repo } = await initRepo();
		const hub = hubFor(paths);
		const session = await hub.create(repo, "gone", { branch: "clean-me" });
		const path = session.cwd;
		await hub.archive(session.id);
		const result = await hub.removeWorktree({ cwd: repo, worktree: { branch: "clean-me" } });
		assert.equal(result.removed, true);
		assert.equal(await exists(path), false);
		assert.equal(
			(await hub.listWorktrees(repo)).worktrees.some((entry) => entry.branch === "pixip/clean-me"),
			false,
		);
		await hub.shutdown();
	});

	it("requires force for a dirty tree", async () => {
		const paths = await fixtureRoot("pixip-worktree-dirty-");
		const { repo } = await initRepo();
		const hub = hubFor(paths);
		const session = await hub.create(repo, "dirty", { branch: "dirty-me" });
		await hub.archive(session.id);
		await writeFile(join(session.cwd, "untracked.txt"), "change\n");

		const refused = await hub.removeWorktree({ cwd: repo, worktree: { branch: "dirty-me" } });
		assert.equal(refused.removed, false);
		if (!refused.removed) {
			assert.equal(refused.reason, "dirty");
			assert.equal(refused.worktree.changedFiles, 1);
		}
		const forced = await hub.removeWorktree({ cwd: repo, worktree: { branch: "dirty-me" }, force: true });
		assert.equal(forced.removed, true);
		await hub.shutdown();
	});

	it("never removes an external worktree, even with force", async () => {
		const paths = await fixtureRoot("pixip-worktree-external-");
		const { root, repo } = await initRepo();
		const external = join(root, "external-tree");
		await git(repo, "worktree", "add", "-b", "external-branch", external, "HEAD");
		const hub = hubFor(paths);
		const listing = await hub.listWorktrees(repo);
		const target = listing.worktrees.find((entry) => entry.path === external);
		assert.equal(target?.pixipActive, false);
		const refused = await hub.removeWorktree({
			cwd: repo,
			worktree: { branch: "external-branch" },
			force: true,
		});
		assert.equal(refused.removed, false);
		if (!refused.removed) assert.equal(refused.reason, "external");
		assert.equal(await exists(external), true);
		await hub.shutdown();
	});
});

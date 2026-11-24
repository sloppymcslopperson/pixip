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

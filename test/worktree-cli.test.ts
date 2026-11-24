import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { pidAlive, readDaemonState } from "../src/daemon.ts";
import { worktreePath } from "../src/worktree.ts";
import { cleanupRoots, exists, FIXTURE, tempRoot, testRoots } from "./helpers/harness.ts";

const runGit = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "pixip test",
	GIT_AUTHOR_EMAIL: "pixip@example.invalid",
	GIT_COMMITTER_NAME: "pixip test",
	GIT_COMMITTER_EMAIL: "pixip@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await runGit("git", ["-C", cwd, ...args], { env: GIT_ENV });
	return stdout.trim();
}

async function initRepo(): Promise<{ root: string; repo: string }> {
	const root = await tempRoot("pixip-worktree-cli-");
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-b", "main");
	await writeFile(join(repo, "file.txt"), "one\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-m", "init");
	return { root, repo };
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ env: { ...process.env, ...env }, timeout: 60_000 },
			(error, stdout, stderr) => {
				const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code: exit, stdout, stderr });
			},
		);
	});
}

async function start(dir: string): Promise<{ url: string; pid: number }> {
	const result = await run(["start", "--data-dir", dir, "--port", "0", "--pi", FIXTURE]);
	assert.equal(result.code, 0, result.stderr);
	const match = /on (http\S+)/.exec(result.stdout);
	assert.ok(match?.[1], result.stdout);
	const state = await readDaemonState(dir);
	assert.ok(state);
	return { url: state.url, pid: state.pid };
}

async function createSession(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await fetch(new URL("api/sessions", url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text) as Record<string, unknown>;
}

async function archiveSession(url: string, id: string): Promise<void> {
	const response = await fetch(new URL(`api/sessions/${encodeURIComponent(id)}/archive`, url), { method: "POST" });
	assert.equal(response.status, 200, await response.text());
}

interface ListedWorktree {
	path: string;
	branch: string;
	owner: "pixip" | "external";
	liveAgents: number;
	dirty: boolean;
	changedFiles: number;
	sessions: Array<{ id: string; name: string; state: string; live: boolean }>;
}

interface Listing {
	repo: string;
	worktrees: ListedWorktree[];
}

function listingOf(result: RunResult): Listing {
	assert.equal(result.code, 0, result.stderr);
	return JSON.parse(result.stdout) as Listing;
}

after(async () => {
	for (const dir of testRoots()) {
		const state = await readDaemonState(dir);
		if (state && pidAlive(state.pid)) {
			try {
				process.kill(state.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
	await cleanupRoots();
});

describe("pixip worktree CLI", () => {
	it("lists repository trees, owners, live agents and session names from the daemon", async () => {
		const dir = await tempRoot("pixip-worktree-cli-");
		const { repo } = await initRepo();
		const { url } = await start(dir);
		const created = await createSession(url, {
			cwd: repo,
			name: "cli-live",
			worktree: { branch: "cli-live" },
		});
		const path = worktreePath(repo, "cli-live");
		await writeFile(join(path, "dirty.txt"), "change\n");

		const json = listingOf(await run(["worktree", "list", repo, "--data-dir", dir, "--json"]));
		assert.equal(json.repo, repo);
		const target = json.worktrees.find((entry) => entry.path === path);
		assert.ok(target);
		assert.equal(target.branch, "pixip/cli-live");
		assert.equal(target.owner, "pixip");
		assert.equal(target.liveAgents, 1);
		assert.equal(target.dirty, true);
		assert.equal(target.changedFiles, 1);
		assert.deepEqual(
			target.sessions.map((session) => session.name),
			["cli-live"],
		);
		assert.equal(target.sessions[0]?.live, true);
		assert.equal(target.sessions[0]?.id, created["logicalId"] ?? created["id"]);

		const human = await run(["worktree", "list", repo, "--data-dir", dir]);
		assert.equal(human.code, 0, human.stderr);
		assert.match(human.stdout, new RegExp(`repo: ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(human.stdout, /cli-live \(idle\)/);

		await run(["stop", "--data-dir", dir]);
		const offline = listingOf(await run(["worktree", "list", repo, "--data-dir", dir, "--json"]));
		const stopped = offline.worktrees.find((entry) => entry.path === path);
		assert.ok(stopped);
		assert.equal(stopped.liveAgents, 0);
		assert.equal(stopped.sessions[0]?.name, "cli-live");
		assert.equal(stopped.sessions[0]?.state, "stopped");
	});

	it("refuses referenced and dirty trees, removes clean with --force and never touches externals", async () => {
		const dir = await tempRoot("pixip-worktree-cli-");
		const { root, repo } = await initRepo();
		const { url } = await start(dir);
		const created = await createSession(url, {
			cwd: repo,
			name: "holder",
			worktree: { branch: "cli-referenced" },
		});
		const path = worktreePath(repo, "cli-referenced");

		const referenced = await run(["worktree", "remove", path, "--data-dir", dir]);
		assert.equal(referenced.code, 2, referenced.stderr);
		assert.match(referenced.stderr, /still reference it/);
		assert.match(referenced.stderr, /holder/);
		assert.equal(await exists(path), true);

		await archiveSession(url, String(created["id"]));
		await writeFile(join(path, "untracked.txt"), "change\n");
		const dirty = await run(["worktree", "remove", path, "--data-dir", dir]);
		assert.equal(dirty.code, 2, dirty.stderr);
		assert.match(dirty.stderr, /1 changed file\(s\); use --force/);

		const forced = await run(["worktree", "remove", path, "--data-dir", dir, "--force"]);
		assert.equal(forced.code, 0, forced.stderr);
		assert.match(forced.stdout, /removed .*pixip\/cli-referenced/);
		assert.equal(await exists(path), false);

		const external = join(root, "external-tree");
		await git(repo, "worktree", "add", "-b", "external-branch", external, "HEAD");
		const refused = await run(["worktree", "remove", external, "--data-dir", dir, "--force"]);
		assert.equal(refused.code, 2, refused.stderr);
		assert.match(refused.stderr, /external worktree; pixip will not remove it/);
		assert.equal(await exists(external), true);

		await run(["stop", "--data-dir", dir]);
	});

	it("prunes a stale worktree", async () => {
		const dir = await tempRoot("pixip-worktree-cli-");
		const { repo } = await initRepo();
		const path = worktreePath(repo, "stale");
		await git(repo, "worktree", "add", "-b", "pixip/stale", path, "HEAD");
		await rm(path, { recursive: true, force: true });

		const pruned = await run(["worktree", "prune", repo, "--data-dir", dir]);
		assert.equal(pruned.code, 0, pruned.stderr);
		assert.equal(pruned.stdout, `pruned ${repo}\n`);

		const json = listingOf(await run(["worktree", "list", repo, "--data-dir", dir, "--json"]));
		assert.equal(
			json.worktrees.some((entry) => entry.path === path),
			false,
		);
	});
});

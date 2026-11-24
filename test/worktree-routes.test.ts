import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import { startServer, type RunningServer } from "../src/server.ts";
import { cleanupRoots, exists, fixtureRoot, hubFor, tempRoot } from "./helpers/harness.ts";

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
	const root = await tempRoot("pixip-worktree-routes-");
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-b", "main");
	await writeFile(join(repo, "file.txt"), "one\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-m", "init");
	return { root, repo };
}

async function boot() {
	const paths = await fixtureRoot("pixip-worktree-routes-");
	const hub = hubFor(paths);
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	return { paths, hub, server };
}

function remove(server: RunningServer, body: Record<string, unknown>) {
	return fetch(new URL("api/worktrees", server.url), {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

after(async () => {
	await cleanupRoots();
});

describe("worktree REST routes", () => {
	it("lists worktrees and reports repository metadata", async () => {
		const { repo } = await initRepo();
		const { hub, server } = await boot();
		try {
			const session = await hub.create(repo, "route", { branch: "route-list" });
			const response = await fetch(new URL(`api/worktrees?cwd=${encodeURIComponent(repo)}`, server.url));
			assert.equal(response.status, 200);
			const listing = (await response.json()) as {
				repo: string;
				worktrees: Array<{ branch: string; path: string; pixipActive: boolean }>;
			};
			assert.equal(listing.repo, repo);
			assert.equal(listing.worktrees[0]?.path, repo);
			assert.equal(
				listing.worktrees.some((entry) => entry.branch === "pixip/route-list"),
				true,
			);
			assert.equal(session.repo, repo);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("refuses a referenced delete with its sessions, then removes it clean", async () => {
		const { repo } = await initRepo();
		const { hub, server } = await boot();
		try {
			const session = await hub.create(repo, "route", { branch: "route-delete" });
			const refused = await remove(server, { cwd: repo, worktree: { branch: "route-delete" } });
			assert.equal(refused.status, 409);
			const body = (await refused.json()) as {
				reason: string;
				sessions: Array<{ logicalId: string }>;
			};
			assert.equal(body.reason, "referenced");
			assert.deepEqual(
				body.sessions.map((row) => row.logicalId),
				[session.logicalId],
			);

			await hub.archive(session.id);
			const deleted = await remove(server, { cwd: repo, worktree: { branch: "route-delete" } });
			assert.equal(deleted.status, 200);
			assert.equal(await exists(session.cwd), false);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("requires force for dirty trees and never removes external ones", async () => {
		const { root, repo } = await initRepo();
		const { hub, server } = await boot();
		try {
			const session = await hub.create(repo, "dirty", { branch: "route-dirty" });
			await hub.archive(session.id);
			await writeFile(join(session.cwd, "untracked.txt"), "change\n");
			const dirty = await remove(server, { cwd: repo, worktree: { branch: "route-dirty" } });
			assert.equal(dirty.status, 409);
			assert.equal(((await dirty.json()) as { reason: string }).reason, "dirty");
			const forced = await remove(server, { cwd: repo, worktree: { branch: "route-dirty" }, force: true });
			assert.equal(forced.status, 200);

			const external = join(root, "external-tree");
			await git(repo, "worktree", "add", "-b", "external-branch", external, "HEAD");
			const refused = await remove(server, {
				cwd: repo,
				worktree: { branch: "external-branch" },
				force: true,
			});
			assert.equal(refused.status, 409);
			assert.equal(((await refused.json()) as { reason: string }).reason, "external");
			assert.equal(await exists(external), true);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});
});

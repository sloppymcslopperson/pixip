import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import { startServer, type RunningServer } from "../src/server.ts";
import type { AgentList } from "../src/agents.ts";
import type { Hub } from "../src/hub.ts";
import {
	cleanupRoots,
	fixtureRoot,
	hubFor,
	infoEntry,
	sessionFile,
	tempRoot,
	type TestPaths,
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
	const root = await tempRoot("pixip-agents-");
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-b", "main");
	await writeFile(join(repo, "file.txt"), "one\n");
	await git(repo, "add", "file.txt");
	await git(repo, "commit", "-m", "init");
	return { root, repo };
}

async function boot(paths: TestPaths): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = hubFor(paths);
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	hub.setDaemonUrl(server.url);
	return { hub, server };
}

async function get(
	server: RunningServer,
	path = "api/agents",
): Promise<{ status: number; body: AgentList | { error: string } }> {
	const response = await fetch(new URL(path, server.url));
	return { status: response.status, body: (await response.json()) as AgentList | { error: string } };
}

function list(body: AgentList | { error: string }): AgentList {
	assert.ok("agents" in body, `expected an agent list, got ${JSON.stringify(body)}`);
	return body;
}

after(async () => {
	await cleanupRoots();
});

describe("GET /api/agents", () => {
	it("returns the same shape with a Host-based URL, self marking and deterministic order", async () => {
		const paths = await fixtureRoot("pixip-agents-route-");
		const { hub, server } = await boot(paths);
		try {
			const first = await hub.create(paths.dir, "alpha");
			await hub.stop(first.id);
			const second = await hub.create(paths.dir, "beta");
			await hub.stop(second.id);

			const { status, body } = await get(server, `api/agents?self=${encodeURIComponent(first.logicalId ?? first.id)}`);
			assert.equal(status, 200);
			const result = list(body);
			assert.equal(result.count, 2);
			assert.equal(result.agents[0]?.id, first.id);
			assert.equal(result.agents[0]?.isSelf, true);
			const agent = result.agents[0];
			assert.ok(agent);
			assert.equal(agent.logicalId, first.logicalId);
			assert.equal(agent.name, "alpha");
			assert.equal(agent.state, "stopped");
			assert.equal(agent.cwd, paths.dir);
			assert.equal(agent.awaitingUser, false);
			assert.equal(typeof agent.lastActivity, "number");
			assert.equal(agent.stored, undefined);
			const host = new URL(server.url).host;
			assert.equal(agent.url, `http://${host}/#s=${encodeURIComponent(first.id)}`);
			assert.equal(result.agents[1]?.isSelf, false);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("hides archive and trash until all=1 and then marks each row", async () => {
		const paths = await fixtureRoot("pixip-agents-stored-");
		const { hub, server } = await boot(paths);
		try {
			const active = await hub.create(paths.dir, "active");
			await hub.stop(active.id);
			const archived = await hub.create(paths.dir, "archived");
			await hub.stop(archived.id);
			await hub.archive(archived.id);
			const trashed = await hub.create(paths.dir, "trashed");
			await hub.stop(trashed.id);
			await hub.deleteSession(trashed.id);

			const hidden = list((await get(server)).body);
			assert.deepEqual(
				hidden.agents.map((agent) => agent.name),
				["active"],
			);

			const all = list((await get(server, "api/agents?all=1")).body);
			assert.equal(all.count, 3);
			const archivedRow = all.agents.find((agent) => agent.id === archived.id);
			const trashedRow = all.agents.find((agent) => agent.id === trashed.id);
			assert.equal(archivedRow?.stored, "archive");
			assert.equal(typeof archivedRow?.archivedAt, "string");
			assert.equal(trashedRow?.stored, "trash");
			assert.equal(typeof trashedRow?.deletedAt, "string");
			assert.equal(typeof trashedRow?.expiresAt, "number");
			assert.match(archivedRow?.url ?? "", /#s=/);

			assert.equal((await hub.listArchived()).length, 1);
			assert.equal((await hub.listTrash()).length, 1);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("filters exactly by cwd and state, and searches query substrings", async () => {
		const paths = await fixtureRoot("pixip-agents-filters-");
		const firstDir = join(paths.dir, "a");
		const secondDir = join(paths.dir, "b");
		await mkdir(firstDir, { recursive: true });
		await mkdir(secondDir, { recursive: true });
		await sessionFile(paths, [infoEntry("alpha")], {
			id: "id-old",
			cwd: firstDir,
			timestamp: "2026-11-21T00:00:00.000Z",
		});
		await sessionFile(paths, [infoEntry("beta")], {
			id: "id-new",
			cwd: firstDir,
			timestamp: "2026-11-21T00:00:02.000Z",
		});
		await sessionFile(paths, [infoEntry("gamma")], {
			id: "id-self",
			cwd: secondDir,
			timestamp: "2026-11-21T00:00:01.000Z",
		});
		const { hub, server } = await boot(paths);
		try {
			const sorted = list((await get(server)).body);
			assert.deepEqual(
				sorted.agents.map((agent) => agent.id),
				["id-new", "id-old", "id-self"],
			);

			const selfFirst = list((await get(server, "api/agents?self=id-self")).body);
			assert.deepEqual(
				selfFirst.agents.map((agent) => agent.id),
				["id-self", "id-new", "id-old"],
			);

			const byCwd = list((await get(server, `api/agents?cwd=${encodeURIComponent(firstDir)}`)).body);
			assert.deepEqual(
				byCwd.agents.map((agent) => agent.id),
				["id-new", "id-old"],
			);
			const subtree = list((await get(server, `api/agents?cwd=${encodeURIComponent(paths.dir)}`)).body);
			assert.equal(subtree.count, 0);

			const byState = list((await get(server, "api/agents?state=stopped")).body);
			assert.equal(byState.count, 3);
			const byQuery = list((await get(server, "api/agents?query=BET")).body);
			assert.deepEqual(
				byQuery.agents.map((agent) => agent.id),
				["id-new"],
			);
			const empty = list((await get(server, "api/agents?query=no-such-agent")).body);
			assert.deepEqual(empty, { agents: [], count: 0 });
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("matches repo filters and reads repository metadata", async () => {
		const { repo } = await initRepo();
		const paths = await fixtureRoot("pixip-agents-repo-");
		const { hub, server } = await boot(paths);
		try {
			const inside = await hub.create(repo, "inside repo");
			await hub.stop(inside.id);
			const outside = await hub.create(paths.dir, "outside repo");
			await hub.stop(outside.id);

			const result = list((await get(server, `api/agents?repo=${encodeURIComponent(repo)}`)).body);
			assert.equal(result.count, 1);
			assert.equal(result.agents[0]?.id, inside.id);
			assert.equal(result.agents[0]?.repo, repo);
			assert.equal(result.agents[0]?.branch, "main");
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("rejects malformed filters with a readable error", async () => {
		const paths = await fixtureRoot("pixip-agents-errors-");
		const { hub, server } = await boot(paths);
		try {
			for (const [path, pattern] of [
				["api/agents?state=running", /unknown state "running"; expected starting, idle, busy, stopped, error/],
				["api/agents?bogus=1", /unknown filter "bogus"/],
				["api/agents?all=maybe", /filter "all" must be 1, true, 0 or false/],
				["api/agents?cwd=", /filter "cwd" must not be empty/],
			] as const) {
				const { status, body } = await get(server, path);
				assert.equal(status, 400, path);
				assert.match((body as { error: string }).error, pattern);
			}
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import { Hub } from "../src/hub.ts";

const run = promisify(execFile);
const roots: string[] = [];

async function root(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-branch-"));
	roots.push(dir);
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", ["-C", cwd, ...args], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "pixip test",
			GIT_AUTHOR_EMAIL: "pixip@example.invalid",
			GIT_COMMITTER_NAME: "pixip test",
			GIT_COMMITTER_EMAIL: "pixip@example.invalid",
		},
	});
	return stdout.trim();
}

async function hubFor(dataDir: string, records: Array<Record<string, unknown>>): Promise<Hub> {
	const sessionsDir = join(dataDir, "sessions");
	const indexPath = join(dataDir, "sessions.json");
	await mkdir(sessionsDir, { recursive: true });
	await writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`);
	return new Hub({
		piBin: "pi",
		sessionsDir,
		dataDir,
		indexPath,
		idleMs: 0,
		extraPiArgs: [],
		log: () => {},
	});
}

function record(cwd: string, id: string): Record<string, unknown> {
	return {
		logicalId: `logical-${id}`,
		piId: id,
		piIds: [id],
		cwd,
		createdAt: "2026-11-21T00:00:00.000Z",
	};
}

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("dashboard git branch", () => {
	it("reports the enclosing repo branch for a repo and a subdirectory", async () => {
		const repo = await root();
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "file.txt"), "x\n");
		await git(repo, "add", "file.txt");
		await git(repo, "commit", "-m", "init");
		const sub = join(repo, "nested", "deeper");
		await mkdir(sub, { recursive: true });

		const hub = await hubFor(await root(), [record(repo, "p1"), record(sub, "p2")]);
		const infos = await hub.list();
		assert.equal(infos.length, 2);
		assert.ok(infos.every((info) => info.branch === "main"));
	});

	it("hides the branch outside a repo and shows the short SHA when detached", async () => {
		const plain = await root();
		const hub = await hubFor(await root(), [record(plain, "p1")]);
		const infos = await hub.list();
		assert.equal(infos[0]?.branch, undefined);

		const repo = await root();
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "file.txt"), "x\n");
		await git(repo, "add", "file.txt");
		await git(repo, "commit", "-m", "init");
		await git(repo, "checkout", "--detach");
		const sha = await git(repo, "rev-parse", "--short", "HEAD");

		const detached = await hubFor(await root(), [record(repo, "p2")]);
		const [info] = await detached.list();
		assert.equal(info?.branch, sha);
	});
});

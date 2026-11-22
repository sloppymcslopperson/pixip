import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

import { cleanupRoots, fixtureRoot, hubFor as harnessHubFor, tempRoot } from "./helpers/harness.ts";

const run = promisify(execFile);

async function hubFor(records: Array<Record<string, unknown>>) {
	const paths = await fixtureRoot("pixip-branch-", { flat: true });
	await writeFile(paths.indexPath, `${JSON.stringify(records, null, 2)}\n`);
	return harnessHubFor(paths);
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
	await cleanupRoots();
});

describe("dashboard git branch", () => {
	it("reports the enclosing repo branch for a repo and a subdirectory", async () => {
		const repo = await tempRoot("pixip-branch-");
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "file.txt"), "x\n");
		await git(repo, "add", "file.txt");
		await git(repo, "commit", "-m", "init");
		const sub = join(repo, "nested", "deeper");
		await mkdir(sub, { recursive: true });

		const hub = await hubFor([record(repo, "p1"), record(sub, "p2")]);
		const infos = await hub.list();
		assert.equal(infos.length, 2);
		assert.ok(infos.every((info) => info.branch === "main"));
	});

	it("hides the branch outside a repo and shows the short SHA when detached", async () => {
		const plain = await tempRoot("pixip-branch-");
		const hub = await hubFor([record(plain, "p1")]);
		const infos = await hub.list();
		assert.equal(infos[0]?.branch, undefined);

		const repo = await tempRoot("pixip-branch-");
		await git(repo, "init", "-b", "main");
		await writeFile(join(repo, "file.txt"), "x\n");
		await git(repo, "add", "file.txt");
		await git(repo, "commit", "-m", "init");
		await git(repo, "checkout", "--detach");
		const sha = await git(repo, "rev-parse", "--short", "HEAD");

		const detached = await hubFor([record(repo, "p2")]);
		const [info] = await detached.list();
		assert.equal(info?.branch, sha);
	});
});

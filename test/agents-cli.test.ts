import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import type { AgentList } from "../src/agents.ts";
import { startServer } from "../src/server.ts";
import { cleanupRoots, fixtureRoot, hubFor, type TestPaths } from "./helpers/harness.ts";

const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
	const clean = { ...process.env };
	delete clean["PIXIP_DAEMON_URL"];
	delete clean["PIXIP_INSIDE"];
	delete clean["PIXIP_SESSION_ID"];
	delete clean["PIXIP_DATA_DIR"];
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ env: { ...clean, ...env }, timeout: 60_000 },
			(error, stdout, stderr) => {
				const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code: exit, stdout, stderr });
			},
		);
	});
}

async function boot(paths: TestPaths) {
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

after(async () => {
	await cleanupRoots();
});

describe("pixip agents list", () => {
	it("prints the JSON envelope, self, filters and the session URL", async () => {
		const paths = await fixtureRoot("pixip-agents-cli-");
		const { hub, server } = await boot(paths);
		try {
			const first = await hub.create(paths.dir, "alpha");
			await hub.stop(first.id);
			const archived = await hub.create(paths.dir, "archived");
			await hub.stop(archived.id);
			await hub.archive(archived.id);

			const hidden = await cli(["agents", "list", "--json"], { PIXIP_DAEMON_URL: server.url });
			assert.equal(hidden.code, 0, hidden.stderr);
			const hiddenList = JSON.parse(hidden.stdout) as AgentList;
			assert.equal(hiddenList.count, 1);
			assert.equal(hiddenList.agents[0]?.id, first.id);

			const all = await cli(["agents", "list", "--json", "--all", "--query", "archive"], {
				PIXIP_DAEMON_URL: server.url,
			});
			assert.equal(all.code, 0, all.stderr);
			const allList = JSON.parse(all.stdout) as AgentList;
			assert.equal(allList.count, 1);
			assert.equal(allList.agents[0]?.stored, "archive");

			const self = await cli(["agents", "list", "--json"], {
				PIXIP_DAEMON_URL: server.url,
				PIXIP_SESSION_ID: first.logicalId ?? first.id,
			});
			assert.equal(self.code, 0, self.stderr);
			const selfList = JSON.parse(self.stdout) as AgentList;
			assert.equal(selfList.agents[0]?.isSelf, true);
			assert.match(selfList.agents[0]?.url ?? "", new RegExp(`#s=${encodeURIComponent(first.id)}$`));

			const table = await cli(["agents", "list"], { PIXIP_DAEMON_URL: server.url });
			assert.equal(table.code, 0, table.stderr);
			assert.match(table.stdout, /SELF/);
			assert.match(table.stdout, /alpha/);
			assert.match(table.stdout, /http:\/\/127\.0\.0\.1:\d+\/#s=/);

			const filtered = await cli(["agents", "list", "--json", "--state", "idle"], {
				PIXIP_DAEMON_URL: server.url,
			});
			assert.equal(filtered.code, 0, filtered.stderr);
			assert.equal((JSON.parse(filtered.stdout) as AgentList).count, 0);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("reports malformed filters and a missing daemon as readable errors", async () => {
		const paths = await fixtureRoot("pixip-agents-cli-error-");
		const { hub, server } = await boot(paths);
		try {
			const badState = await cli(["agents", "list", "--state", "running"], { PIXIP_DAEMON_URL: server.url });
			assert.equal(badState.code, 1);
			assert.match(badState.stderr, /unknown state "running"/);

			const missing = await cli(["agents", "list", "--data-dir", paths.dataDir], {});
			assert.equal(missing.code, 1);
			assert.match(missing.stderr, /pixip is not running/);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});
});

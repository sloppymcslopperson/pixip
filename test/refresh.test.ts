import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { Hub } from "../src/hub.ts";
import { isLoopback, startServer, type RunningServer } from "../src/server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const roots: string[] = [];

interface Paths {
	dir: string;
	dataDir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
	logPath: string;
	logs: string[];
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-refresh-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		dataDir: join(dir, "data"),
		sessionsDir: join(dir, "data", "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "data", "sessions.json"),
		logPath: join(dir, "spawns.jsonl"),
		logs: [],
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

async function boot(paths: Paths): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		extraPiArgs: [],
		env: { FAKE_PI_LOG: paths.logPath },
		log: (message) => paths.logs.push(message),
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: (message) => paths.logs.push(message),
	});
	return { hub, server };
}

interface Inbox {
	frames: Array<Record<string, unknown>>;
	ws: WebSocket;
	close: () => void;
}

async function connect(url: string): Promise<Inbox> {
	const ws = new WebSocket(url);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
		} catch {
			// failed assertions below will show it
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { frames, ws, close: () => ws.close() };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for condition");
}

const policyFrames = (inbox: Inbox) => inbox.frames.filter((frame) => frame["t"] === "policy");

async function spawnCount(paths: Paths): Promise<number> {
	const text = await readFile(paths.logPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: string })
		.filter((record) => record.type === "spawn").length;
}

async function postRefresh(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(new URL("api/refresh", url), { method: "POST" });
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("soft refresh", () => {
	it("serves new client bytes without a restart and reports counters", async () => {
		const paths = await fixtureRoot();
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths);

		assert.equal(await (await fetch(server.url)).text(), "v1");
		await writeFile(join(paths.clientDir, "index.html"), "v2");

		const report = await postRefresh(server.url);
		assert.equal(report.status, 200);
		assert.deepEqual(report.body["reloaded"], ["assets", "config", "index", "commands"]);
		assert.equal(report.body["reloads"], 1);
		assert.equal(await (await fetch(server.url)).text(), "v2");

		const health = (await (await fetch(new URL("health", server.url))).json()) as Record<string, unknown>;
		assert.equal(health["ok"], true);
		assert.equal(health["reloads"], 1);
		assert.equal(health["pid"], process.pid);
		assert.ok(Date.now() - Number(health["startedAt"]) < 60_000);

		// Repeated refreshes are safe and increment the counter.
		assert.equal((await postRefresh(server.url)).body["reloads"], 2);
		await server.close();
		await hub.shutdown();
	});

	it("re-resolves policy for live sessions and keeps the child", async () => {
		const paths = await fixtureRoot();
		const project = join(paths.dir, "project");
		await mkdir(project, { recursive: true });
		await writeFile(join(paths.dataDir, "pixip.json"), JSON.stringify({ commands: { deny: ["logout"] } }));
		const { hub, server } = await boot(paths);
		const created = await hub.create(project);
		const inbox = await connect(`${server.url}ws?session=${created.id}`);
		await waitFor(() => policyFrames(inbox).length === 1);
		assert.deepEqual(policyFrames(inbox)[0]?.["policy"], { allow: [], deny: ["logout"], bash: true });
		assert.equal(await spawnCount(paths), 1);

		await writeFile(join(paths.dataDir, "pixip.json"), JSON.stringify({ commands: { deny: ["name"], bash: false } }));
		assert.equal((await postRefresh(server.url)).status, 200);
		await waitFor(() => policyFrames(inbox).length === 2);
		assert.deepEqual(policyFrames(inbox)[1]?.["policy"], { allow: [], deny: ["name"], bash: false });
		assert.deepEqual(hub.policy(created.id), { allow: [], deny: ["name"], bash: false });

		// The child was never respawned: one spawn record, and it still answers.
		assert.equal(await spawnCount(paths), 1);
		const models = await hub.models(created.id);
		assert.deepEqual(models.models, []);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("broadcasts a fresh session list to list sockets", async () => {
		const paths = await fixtureRoot();
		const { hub, server } = await boot(paths);
		const inbox = await connect(`${server.url}ws`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "hello"));
		await hub.create(paths.dir);
		const before = inbox.frames.filter((frame) => frame["t"] === "sessions").length;
		assert.equal((await postRefresh(server.url)).status, 200);
		await waitFor(() => inbox.frames.filter((frame) => frame["t"] === "sessions").length > before);
		const list = inbox.frames.filter((frame) => frame["t"] === "sessions").at(-1);
		assert.equal((list?.["sessions"] as unknown[]).length, 1);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("fails a malformed policy refresh without half-applying it", async () => {
		const paths = await fixtureRoot();
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server.url}ws?session=${created.id}`);
		await waitFor(() => policyFrames(inbox).length === 1);

		await writeFile(join(paths.dataDir, "pixip.json"), "{oops");
		const failed = await postRefresh(server.url);
		assert.equal(failed.status, 500);
		assert.match(String(failed.body["error"]), /pixip\.json: invalid JSON/);
		assert.equal(policyFrames(inbox).length, 1);
		const health = (await (await fetch(new URL("health", server.url))).json()) as Record<string, unknown>;
		assert.equal(health["reloads"], 0);
		assert.equal(await spawnCount(paths), 1);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});
});

describe("refresh guard", () => {
	const request = (address: string) => ({ socket: { remoteAddress: address } }) as unknown as IncomingMessage;

	it("accepts loopback peers only", () => {
		for (const address of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"]) {
			assert.equal(isLoopback(request(address)), true, address);
		}
		for (const address of ["192.168.1.5", "::2", "10.0.0.1", ""]) {
			assert.equal(isLoopback(request(address)), false, address);
		}
	});
});

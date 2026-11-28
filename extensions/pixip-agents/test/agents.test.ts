import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import { listAgents, runAgentListTool } from "../src/agents.ts";

interface Captured {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
}

interface TestServer {
	url: string;
	captured: Captured[];
	close: () => Promise<void>;
}

const agent = {
	id: "pi-1",
	logicalId: "logical-1",
	name: "Review migration",
	state: "idle",
	cwd: "/work/pixip",
	repo: "/work/pixip",
	branch: "main",
	awaitingUser: false,
	lastActivity: 1735689600000,
	isSelf: true,
	url: "http://127.0.0.1:8137/#s=pi-1",
};

async function server(
	status = 200,
	reply: Record<string, unknown> = { agents: [agent], count: 1 },
): Promise<TestServer> {
	const captured: Captured[] = [];
	const instance = createServer((req: IncomingMessage, res: ServerResponse) => {
		req.resume();
		req.on("end", () => {
			captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", () => resolve()));
	const address = instance.address();
	assert.ok(address && typeof address === "object");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		captured,
		close: () => new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve()))),
	};
}

const servers: TestServer[] = [];

async function boot(status = 200, reply?: Record<string, unknown>): Promise<TestServer> {
	const instance = await server(status, reply);
	servers.push(instance);
	return instance;
}

after(async () => {
	await Promise.all(servers.splice(0).map((instance) => instance.close()));
});

describe("agent_list", () => {
	it("GETs the discovery route with filters, resolved paths and the caller as self", async () => {
		const hub = await boot();
		const result = await listAgents(
			{ all: true, cwd: "./sub", repo: "~/pixip", state: "idle", query: "migration" },
			{ env: { PIXIP_DAEMON_URL: hub.url, PIXIP_SESSION_ID: "self-1", HOME: "/home/test" }, cwd: "/work" },
		);
		assert.deepEqual(result, { agents: [agent], count: 1 });
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal(call.method, "GET");
		const url = new URL(call.url, "http://localhost");
		assert.equal(url.pathname, "/api/agents");
		assert.equal(url.searchParams.get("all"), "1");
		assert.equal(url.searchParams.get("cwd"), "/work/sub");
		assert.equal(url.searchParams.get("repo"), "/home/test/pixip");
		assert.equal(url.searchParams.get("state"), "idle");
		assert.equal(url.searchParams.get("query"), "migration");
		assert.equal(url.searchParams.get("self"), "self-1");
	});

	it("omits empty filters and self outside a pixip session", async () => {
		const hub = await boot();
		await listAgents({}, { env: { PIXIP_DAEMON_URL: hub.url } });
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal(call.url, "/api/agents");
	});

	it("explains a missing PIXIP_DAEMON_URL instead of guessing an address", async () => {
		await assert.rejects(() => listAgents({}, { env: {} }), /PIXIP_DAEMON_URL is not set/);
	});

	it("validates state locally before a request", async () => {
		await assert.rejects(
			() => listAgents({ state: "running" }, { env: { PIXIP_DAEMON_URL: "http://127.0.0.1:1/" } }),
			/state must be one of/,
		);
	});

	it("turns a daemon filter error into an actionable tool error", async () => {
		const hub = await boot(400, { error: 'unknown state "running"; expected starting, idle, busy, stopped, error' });
		const result = await runAgentListTool({}, { env: { PIXIP_DAEMON_URL: hub.url } });
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /unknown state "running"/);
		assert.deepEqual(result.details, {
			agents: [],
			count: 0,
			error: 'agent list failed: unknown state "running"; expected starting, idle, busy, stopped, error',
		});
	});

	it("formats text with the URL and passes the envelope through details", async () => {
		const hub = await boot();
		const result = await runAgentListTool({}, { env: { PIXIP_DAEMON_URL: hub.url } });
		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Review migration/);
		assert.match(text, /self/);
		assert.match(text, /http:\/\/127\.0\.0\.1:8137\/#s=pi-1/);
		assert.deepEqual(result.details, { agents: [agent], count: 1 });
	});

	it("reports an empty result as a normal success", async () => {
		const hub = await boot(200, { agents: [], count: 0 });
		const result = await runAgentListTool({}, { env: { PIXIP_DAEMON_URL: hub.url } });
		assert.equal(result.isError, undefined);
		assert.equal(result.content[0]?.text, "No pixip agents found.");
		assert.deepEqual(result.details, { agents: [], count: 0 });
	});
});

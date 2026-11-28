import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import { listAgents, runAgentListTool, runAgentSendTool, sendAgentMessage } from "../src/agents.ts";

interface Captured {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
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
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			captured.push({
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});
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

const sendAck = {
	deliveryId: "delivery-1",
	target: {
		id: "pi-1",
		name: "Review migration",
		url: "http://127.0.0.1:8137/#s=pi-1",
		stateBefore: "idle",
		stateAfter: "idle",
	},
	delivered: true,
	woken: false,
	streaming: false,
	at: "2026-11-21T00:00:00.000Z",
};

describe("agent_send", () => {
	it("POSTs the target, message and caller as sender", async () => {
		const hub = await boot(200, sendAck);
		const ack = await sendAgentMessage(
			{ target: "Review migration", message: "please look" },
			{ env: { PIXIP_DAEMON_URL: hub.url, PIXIP_SESSION_ID: "self-1" } },
		);
		assert.deepEqual(ack, sendAck);
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal(call.method, "POST");
		assert.equal(call.url, "/api/agents/Review%20migration/messages");
		assert.deepEqual(JSON.parse(call.body), { message: "please look", sender: "self-1" });
	});

	it("uses local-shell outside a pixip session and returns the URL in tool text", async () => {
		const hub = await boot(200, sendAck);
		const result = await runAgentSendTool({ target: "pi-1", message: "hello" }, { env: { PIXIP_DAEMON_URL: hub.url } });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Delivered delivery-1/);
		assert.match(result.content[0]?.text ?? "", /http:\/\/127\.0\.0\.1:8137\/#s=pi-1/);
		assert.deepEqual(result.details, sendAck);
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal((JSON.parse(call.body) as { sender: string }).sender, "local-shell");
	});

	it("turns ambiguity into an actionable tool error", async () => {
		const hub = await boot(409, { error: 'ambiguous agent "dup"; matches: one [a], two [b]' });
		const result = await runAgentSendTool({ target: "dup", message: "hello" }, { env: { PIXIP_DAEMON_URL: hub.url } });
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /ambiguous agent "dup"/);
		assert.equal(result.details.delivered, false);
		assert.equal(result.details.error, 'agent send failed: ambiguous agent "dup"; matches: one [a], two [b]');
	});

	it("explains a missing daemon and validates empty input before a request", async () => {
		await assert.rejects(
			() => sendAgentMessage({ target: "x", message: "y" }, { env: {} }),
			/PIXIP_DAEMON_URL is not set/,
		);
		await assert.rejects(
			() => sendAgentMessage({ target: "x", message: " " }, { env: { PIXIP_DAEMON_URL: "http://127.0.0.1:1/" } }),
			/message must not be empty/,
		);
	});
});

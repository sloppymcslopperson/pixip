import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import { announceInbox, runInboxTool, sendToInbox } from "../src/inbox.ts";

interface Captured {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

interface TestServer {
	url: string;
	captured: Captured[];
	close: () => Promise<void>;
}

async function server(
	status = 200,
	reply: Record<string, unknown> = { ok: true, message: { id: "abcdef123456", subject: "hello", purpose: "no-rush" } },
): Promise<TestServer> {
	const captured: Captured[] = [];
	const instance = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			} catch {}
			captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
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

describe("inbox_send", () => {
	it("posts subject, body, purpose, session and token to the hub endpoint", async () => {
		const hub = await boot();
		const result = await sendToInbox(
			{ subject: "  Review  ", body: "the body", purpose: "attention-needed" },
			{
				env: {
					PIXIP_DAEMON_URL: hub.url,
					PIXIP_SESSION_ID: "logical-1",
					PIXIP_INBOX_TOKEN: "secret",
				},
			},
		);
		assert.equal(result.id, "abcdef123456");
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal(call.method, "POST");
		assert.equal(call.url, "/api/inbox");
		assert.equal(call.headers["authorization"], "Bearer secret");
		assert.deepEqual(call.body, {
			subject: "Review",
			body: "the body",
			purpose: "attention-needed",
			sessionId: "logical-1",
		});
	});

	it("omits the bearer header and session id when the environment is bare", async () => {
		const hub = await boot();
		await sendToInbox({ subject: "hello", body: "body", purpose: "no-rush" }, { env: { PIXIP_DAEMON_URL: hub.url } });
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal("authorization" in call.headers, false);
		assert.equal("sessionId" in call.body, false);
	});

	it("explains a missing PIXIP_DAEMON_URL instead of guessing an address", async () => {
		await assert.rejects(
			() => sendToInbox({ subject: "x", body: "y", purpose: "extra-info" }, { env: {} }),
			/PIXIP_DAEMON_URL is not set/,
		);
	});

	it("validates purpose, subject and body before a request", async () => {
		await assert.rejects(
			() =>
				sendToInbox(
					{ subject: "x", body: "y", purpose: "urgent" as never },
					{ env: { PIXIP_DAEMON_URL: "http://127.0.0.1:1/" } },
				),
			/purpose must be one of/,
		);
		await assert.rejects(
			() => sendToInbox({ subject: "  ", body: "y", purpose: "no-rush" }, { env: {} }),
			/subject is required/,
		);
		await assert.rejects(
			() => sendToInbox({ subject: "x", body: " ", purpose: "no-rush" }, { env: {} }),
			/body is required/,
		);
	});

	it("turns a wrong token into an actionable error", async () => {
		const hub = await boot(401, { error: "inbox token required" });
		await assert.rejects(
			() =>
				sendToInbox(
					{ subject: "x", body: "y", purpose: "no-rush" },
					{ env: { PIXIP_DAEMON_URL: hub.url, PIXIP_INBOX_TOKEN: "wrong" } },
				),
			/rejected PIXIP_INBOX_TOKEN/,
		);
	});

	it("reports an unreachable daemon with the URL and remedy", async () => {
		await assert.rejects(
			() =>
				sendToInbox(
					{ subject: "x", body: "y", purpose: "no-rush" },
					{ env: { PIXIP_DAEMON_URL: "http://127.0.0.1:1/" }, timeoutMs: 500 },
				),
			/could not reach the pixip daemon/,
		);
	});

	it("announces itself so an empty inbox bar can appear, and never throws", async () => {
		const hub = await boot();
		assert.equal(await announceInbox({ env: { PIXIP_DAEMON_URL: hub.url } }), true);
		const call = hub.captured[0];
		assert.ok(call);
		assert.equal(call.method, "POST");
		assert.equal(call.url, "/api/inbox/extension");
		assert.equal("authorization" in call.headers, false);

		const token = await boot();
		await announceInbox({ env: { PIXIP_DAEMON_URL: token.url, PIXIP_INBOX_TOKEN: "secret" } });
		assert.equal(token.captured[0]?.headers["authorization"], "Bearer secret");

		// No daemon URL, or a daemon that is not listening: silently no report.
		assert.equal(await announceInbox({ env: {} }), false);
		assert.equal(await announceInbox({ env: { PIXIP_DAEMON_URL: "http://127.0.0.1:1/" }, timeoutMs: 500 }), false);
	});

	it("returns a tool result, and a tool error instead of throwing", async () => {
		const hub = await boot();
		const success = await runInboxTool(
			{ subject: "hello", body: "body", purpose: "no-rush" },
			{ env: { PIXIP_DAEMON_URL: hub.url } },
		);
		assert.equal("isError" in success, false);
		assert.match((success.content[0] as { text: string }).text, /pixip inbox/);

		const bad = await runInboxTool({ subject: "hello", body: "body", purpose: "no-rush" }, { env: {} });
		assert.equal("isError" in bad && bad.isError, true);
		assert.match((bad.content[0] as { text: string }).text, /PIXIP_DAEMON_URL/);
	});
});

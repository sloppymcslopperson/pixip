import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Captured {
	method: string;
	url: string;
	body: string;
}

interface FakeDaemon {
	url: string;
	captured: Captured[];
	close: () => Promise<void>;
}

const servers: FakeDaemon[] = [];

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

async function fakeDaemon(status = 200, reply: Record<string, unknown> = {}): Promise<FakeDaemon> {
	const captured: Captured[] = [];
	const instance = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			captured.push({
				method: req.method ?? "",
				url: req.url ?? "",
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", () => resolve()));
	const address = instance.address();
	assert.ok(address && typeof address === "object");
	const daemon: FakeDaemon = {
		url: `http://127.0.0.1:${address.port}/`,
		captured,
		close: () => new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve()))),
	};
	servers.push(daemon);
	return daemon;
}

const ack = {
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

after(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("pixip agents send", () => {
	it("posts the target, joined message and caller, then prints the ack and URL", async () => {
		const daemon = await fakeDaemon(200, ack);
		const result = await cli(["agents", "send", "Review migration", "please", "review"], {
			PIXIP_DAEMON_URL: daemon.url,
			PIXIP_SESSION_ID: "self-1",
		});
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /delivered delivery-1 to Review migration \[pi-1\] \(idle -> idle\)/);
		assert.match(result.stdout, /http:\/\/127\.0\.0\.1:8137\/#s=pi-1/);
		const call = daemon.captured[0];
		assert.ok(call);
		assert.equal(call.method, "POST");
		assert.equal(call.url, "/api/agents/Review%20migration/messages");
		assert.deepEqual(JSON.parse(call.body), { message: "please review", sender: "self-1" });
	});

	it("prints the JSON acknowledgement and falls back to local-shell", async () => {
		const daemon = await fakeDaemon(200, ack);
		const result = await cli(["agents", "send", "pi-1", "hello", "--json"], { PIXIP_DAEMON_URL: daemon.url });
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ack);
		const call = daemon.captured[0];
		assert.ok(call);
		assert.equal((JSON.parse(call.body) as { sender: string }).sender, "local-shell");
	});

	it("prints daemon ambiguity as an error and exits non-zero", async () => {
		const daemon = await fakeDaemon(409, { error: 'ambiguous agent "dup"; matches: one [a], two [b]' });
		const result = await cli(["agents", "send", "dup", "hello"], { PIXIP_DAEMON_URL: daemon.url });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /ambiguous agent "dup"/);
		assert.equal(result.stdout, "");
	});

	it("rejects a missing message without calling the daemon", async () => {
		const daemon = await fakeDaemon(200, ack);
		const result = await cli(["agents", "send", "pi-1"], { PIXIP_DAEMON_URL: daemon.url });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /usage: pixip agents send <target> <message>/);
		assert.equal(daemon.captured.length, 0);
	});
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachJsonlLineReader, serializeJsonLine } from "../src/protocol.ts";

/**
 * Real-SDK smoke test: spawn the host against a temporary data dir, check the
 * `hello` record, read state/entries without prompting a model, then shut down.
 *
 * Run with `npm run smoke` in `pi-host/`. This is intentionally outside
 * `npm run check`, which stays hermetic with a fake runtime.
 */

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const timeoutMs = 60_000;
const dataDir = await mkdtemp(join(tmpdir(), "pixip-pi-host-smoke-"));
const child = spawn(process.execPath, [main, "--mode", "rpc", "--session-dir", dataDir], {
	cwd: process.cwd(),
	stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
	stderr += chunk;
});

const records: any[] = [];
const waiters: Array<{ match: (record: any) => boolean; resolve: (record: any) => void }> = [];

attachJsonlLineReader(child.stdout, (line) => {
	let record: any;
	try {
		record = JSON.parse(line);
	} catch {
		throw new Error(`non-JSON stdout line: ${line.slice(0, 200)}`);
	}
	records.push(record);
	for (const waiter of [...waiters]) {
		if (waiter.match(record)) {
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(record);
		}
	}
});

function waitFor(match: (record: any) => boolean, label: string): Promise<any> {
	const existing = records.find(match);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`timed out waiting for ${label}\nstderr:\n${stderr}`));
		}, timeoutMs);
		waiters.push({
			match,
			resolve: (record) => {
				clearTimeout(timer);
				resolve(record);
			},
		});
	});
}

function send(command: Record<string, unknown>): void {
	child.stdin.write(serializeJsonLine(command));
}

function waitForExit(): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`host did not exit\nstderr:\n${stderr}`));
		}, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

try {
	const hello = await waitFor((record) => record.type === "hello", "hello");
	assert.equal(hello.protocol, 1);
	assert.deepEqual(hello.capabilities, ["panel"]);
	assert.match(String(hello.piVersion), /^\d+\.\d+\.\d+/);

	send({ id: "state", type: "get_state" });
	const state = await waitFor(
		(record) => record.type === "response" && record.id === "state",
		"get_state response",
	);
	assert.equal(state.success, true, state.error);
	assert.equal(typeof state.data.sessionId, "string");

	send({ id: "entries", type: "get_entries" });
	const entries = await waitFor(
		(record) => record.type === "response" && record.id === "entries",
		"get_entries response",
	);
	assert.equal(entries.success, true, entries.error);
	assert.ok(Array.isArray(entries.data.entries));
	assert.ok("leafId" in entries.data);

	send({ id: "bye", type: "shutdown" });
	const bye = await waitFor(
		(record) => record.type === "response" && record.id === "bye",
		"shutdown response",
	);
	assert.equal(bye.success, true, bye.error);
	const code = await waitForExit();
	assert.equal(code, 0, stderr);
	console.log("smoke ok: hello, get_state, get_entries, shutdown");
} finally {
	if (child.exitCode === null) child.kill("SIGKILL");
	await rm(dataDir, { recursive: true, force: true });
}

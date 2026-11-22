import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { CommandLayer } from "../src/commands.ts";
import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import {
	cleanupRoots,
	fixtureRoot,
	hubFor as harnessHubFor,
	spawns as records,
	waitFor,
	type TestPaths,
} from "./helpers/harness.ts";

interface BootOptions {
	env?: Record<string, string>;
	cliCommands?: CommandLayer;
	promptTimeoutMs?: number;
	server?: boolean;
}

async function boot(
	paths: TestPaths,
	options: BootOptions = {},
): Promise<{ hub: Hub; server?: RunningServer; url: string }> {
	const hub = harnessHubFor(
		paths,
		{
			cliCommands: options.cliCommands,
			promptTimeoutMs: options.promptTimeoutMs,
			log: (message) => paths.logs.push(message),
		},
		options.env,
	);
	if (options.server === false) return { hub, url: "" };
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: (message) => paths.logs.push(message),
	});
	return { hub, server, url: server.url };
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
			// a broken frame fails the assertions below anyway
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { frames, ws, close: () => ws.close() };
}

const frameOf = (inbox: Inbox, type: string) => inbox.frames.filter((frame) => frame["t"] === type);
const eventsOf = (inbox: Inbox, type: string) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => frame["ev"] as Record<string, unknown>)
		.filter((event) => event?.["type"] === type);

after(async () => {
	await cleanupRoots();
});

describe("! and !!", () => {
	it("streams bash updates into the card id and finishes with the result", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths, { env: { FAKE_PI_BASH_DELTA: "hello\n" } });
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server?.url}ws?session=${created.id}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));

		inbox.ws.send(JSON.stringify({ t: "bash", id: "b1-test", command: "echo hi", excludeFromContext: false }));
		await waitFor(() => frameOf(inbox, "bash").length > 0);

		const updates = eventsOf(inbox, "bash_execution_update");
		assert.ok(updates.length >= 1);
		assert.deepEqual(
			updates.map((event) => event["id"]),
			updates.map(() => "b1-test"),
		);
		assert.equal(updates[0]?.["delta"], "hello\n");

		const [result] = frameOf(inbox, "bash");
		assert.equal(result?.["id"], "b1-test");
		assert.equal(result?.["command"], "echo hi");
		assert.equal(result?.["output"], "hello\n");
		assert.equal(result?.["exitCode"], 0);
		assert.equal(result?.["cancelled"], false);
		assert.equal(result?.["truncated"], false);
		assert.equal(result?.["excludeFromContext"], false);
		assert.equal(result?.["error"], undefined);

		const bash = (await records(paths)).filter((record) => record["type"] === "bash");
		assert.equal(bash.length, 1);
		assert.equal(bash[0]?.["id"], "b1-test");
		assert.equal(bash[0]?.["command"], "echo hi");
		assert.equal(bash[0]?.["excludeFromContext"], false);

		inbox.close();
		await server?.close();
		await hub.shutdown();
	});

	it("carries the excluded flag and truncation metadata for !!", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths, {
			env: {
				FAKE_PI_BASH_OUTPUT: "secret output\n",
				FAKE_PI_BASH_TRUNCATED: "1",
				FAKE_PI_BASH_FULL_OUTPUT: "/tmp/pi-bash-full.log",
			},
		});
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server?.url}ws?session=${created.id}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));

		inbox.ws.send(JSON.stringify({ t: "bash", id: "b2-test", command: "cat secret", excludeFromContext: true }));
		await waitFor(() => frameOf(inbox, "bash").length > 0);
		const [result] = frameOf(inbox, "bash");
		assert.equal(result?.["excludeFromContext"], true);
		assert.equal(result?.["output"], "secret output\n");
		assert.equal(result?.["truncated"], true);
		assert.equal(result?.["fullOutputPath"], "/tmp/pi-bash-full.log");

		const bash = (await records(paths)).filter((record) => record["type"] === "bash");
		assert.equal(bash[0]?.["excludeFromContext"], true);

		inbox.close();
		await server?.close();
		await hub.shutdown();
	});

	it("refuses a second bash while one is running", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub } = await boot(paths, { env: { FAKE_PI_BASH_DELAY_MS: "200" }, server: false });
		const created = await hub.create(paths.dir);
		const first = hub.bash(created.id, "b1", "sleep 1", false);
		await assert.rejects(hub.bash(created.id, "b2", "echo nope", false), /already running/);
		await first;
		// Once the first finishes the slot is free again.
		const again = await hub.bash(created.id, "b3", "echo ok", false);
		assert.equal(again.exitCode, 0);
		await hub.shutdown();
	});

	it("reports a failed bash on the matching card id, not as a generic error", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server?.url}ws?session=${created.id}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));

		inbox.ws.send(JSON.stringify({ t: "bash", id: "b3-test", command: "   ", excludeFromContext: false }));
		await waitFor(() => frameOf(inbox, "bash").length > 0);
		const [result] = frameOf(inbox, "bash");
		assert.equal(result?.["id"], "b3-test");
		assert.match(String(result?.["error"]), /empty bash command/);

		inbox.close();
		await server?.close();
		await hub.shutdown();
	});
});

describe("slash passthrough", () => {
	it("forwards the text verbatim and steers while busy", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server?.url}ws?session=${created.id}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));

		inbox.ws.send(JSON.stringify({ t: "prompt", text: "/fit  list --all", streamingBehavior: "steer" }));
		await waitFor(() => hasPrompt(paths));
		assert.equal(frameOf(inbox, "error").length, 0);

		const prompt = (await records(paths)).find((record) => record["type"] === "prompt");
		assert.equal(prompt?.["text"], "/fit  list --all");
		assert.equal(prompt?.["streamingBehavior"], "steer");

		inbox.close();
		await server?.close();
		await hub.shutdown();
	});

	it("treats a prompt response later than the configured timeout as advisory", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const { hub } = await boot(paths, {
			env: { FAKE_PI_PROMPT_DELAY_MS: "120" },
			promptTimeoutMs: 20,
			server: false,
		});
		const created = await hub.create(paths.dir);
		await hub.prompt(created.id, "/fit help", "steer");
		// The fake logs on receipt, before the delayed response.
		await waitFor(async () => (await records(paths)).some((record) => record["type"] === "prompt"));
		const prompt = (await records(paths)).find((record) => record["type"] === "prompt");
		assert.equal(prompt?.["text"], "/fit help");
		assert.ok(paths.logs.some((line) => line.includes("timeout waiting for prompt")));
		await hub.shutdown();
	});
});

async function hasPrompt(paths: TestPaths): Promise<boolean> {
	return (await records(paths)).some((record) => record["type"] === "prompt");
}

describe("policy frame", () => {
	it("sends the merged per-session policy on attach", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		const cwd = join(paths.dir, "project");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(paths.dataDir, "pixip.json"), JSON.stringify({ commands: { deny: ["name"], bash: false } }));
		await writeFile(join(cwd, ".pixip.json"), JSON.stringify({ commands: { deny: ["/model"] } }));
		const { hub, server } = await boot(paths);
		const created = await hub.create(cwd);
		const inbox = await connect(`${server?.url}ws?session=${created.id}`);
		await waitFor(() => frameOf(inbox, "policy").length > 0);
		const [policy] = frameOf(inbox, "policy");
		assert.deepEqual(policy?.["policy"], { allow: [], deny: ["name", "model"], bash: false });

		inbox.close();
		await server?.close();
		await hub.shutdown();
	});

	it("fails the attach with the file path when the config is malformed", async () => {
		const paths = await fixtureRoot("pixip-prefix-", { logName: "commands.jsonl" });
		await writeFile(join(paths.dataDir, "pixip.json"), "{oops");
		const { hub } = await boot(paths, { server: false });
		await assert.rejects(hub.create(paths.dir), /pixip\.json: invalid JSON/);
		await hub.shutdown();
	});
});

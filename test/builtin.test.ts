import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const OLD_ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
const NEW_ID = "02b2fc4f-bbbb-7664-b952-f6673a2c7a8d";
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
	const dir = await mkdtemp(join(tmpdir(), "pixip-builtin-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		dataDir: join(dir, "data"),
		sessionsDir: join(dir, "data", "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "data", "sessions.json"),
		logPath: join(dir, "commands.jsonl"),
		logs: [],
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

const MODELS = JSON.stringify([
	{ id: "fake-model", provider: "fake", contextWindow: 100_000 },
	{ id: "other-model", provider: "acme" },
	{ id: "fake-model", provider: "mirror" },
]);

async function boot(
	paths: Paths,
	env: Record<string, string> = {},
): Promise<{ hub: Hub; server: RunningServer; url: string }> {
	const hub = new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		extraPiArgs: [],
		env: {
			FAKE_PI_LOG: paths.logPath,
			FAKE_PI_MODELS: MODELS,
			FAKE_PI_THINKING_LEVELS: "off,low,medium,high",
			...env,
		},
		log: (message) => paths.logs.push(message),
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: (message) => paths.logs.push(message),
	});
	const created = await hub.create(paths.dir);
	return { hub, server, url: `${server.url}ws?session=${created.id}` };
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
			// assertions below will catch a broken frame
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
	throw new Error("timed out waiting for frames");
}

async function records(paths: Paths): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(paths.logPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const framesOf = (inbox: Inbox, type: string) => inbox.frames.filter((frame) => frame["t"] === type);

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("built-in commands over the socket", () => {
	it("compacts with instructions and answers resnapshot with a replace window", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "compact", instructions: "keep the API notes" }));
		await waitFor(() => framesOf(inbox, "event").some((frame) => (frame["ev"] as { type?: string })?.type === "compaction_end"));
		const compact = (await records(paths)).find((record) => record["type"] === "compact");
		assert.equal(compact?.["customInstructions"], "keep the API notes");

		inbox.ws.send(JSON.stringify({ t: "resnapshot" }));
		await waitFor(() => framesOf(inbox, "snapshot").some((frame) => frame["replace"] === true));
		const replaced = framesOf(inbox, "snapshot").at(-1);
		assert.equal(replaced?.["replace"], true);
		assert.equal(replaced?.["resume"], undefined);
		assert.deepEqual(replaced?.["entries"], []);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("renames the session and lets the status frame update the header", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "set_session_name", name: "dogfood" }));
		await waitFor(() => framesOf(inbox, "status").some((frame) => (frame["session"] as { name?: string })?.name === "dogfood"));
		const rename = (await records(paths)).find((record) => record["type"] === "set_session_name");
		assert.equal(rename?.["name"], "dogfood");

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("re-keys a /new session, keeps the socket usable and updates the index piIds", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, {
			FAKE_PI_SESSION_ID: OLD_ID,
			FAKE_PI_NEW_SESSION_ID_AFTER: NEW_ID,
		});
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "new_session" }));
		await waitFor(() => framesOf(inbox, "opened").some((frame) => frame["rekey"] === true));
		const opened = framesOf(inbox, "opened").at(-1);
		assert.equal((opened?.["session"] as { id?: string })?.id, NEW_ID);
		assert.equal((await records(paths)).some((record) => record["type"] === "new_session"), true);

		// The socket's active id followed the re-key: a normal command still works.
		inbox.ws.send(JSON.stringify({ t: "models" }));
		await waitFor(() => framesOf(inbox, "models").length > 0);
		assert.ok((framesOf(inbox, "models")[0]?.["models"] as unknown[]).length > 0);

		const index = JSON.parse(await readFile(paths.indexPath, "utf8")) as Array<Record<string, unknown>>;
		const record = index.find((entry) => entry["logicalId"]);
		assert.equal(record?.["piId"], NEW_ID);
		assert.deepEqual(record?.["piIds"], [OLD_ID, NEW_ID]);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("surfaces get_commands on the commands frame once per attach", async () => {
		const paths = await fixtureRoot();
		const DISCOVERED = JSON.stringify([
			{ name: "fit", description: "FIT board", source: "extension" },
			{ name: "skill:review", description: "Review the diff", source: "skill" },
		]);
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID, FAKE_PI_COMMANDS: DISCOVERED });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "commands").length > 0);
		assert.deepEqual(framesOf(inbox, "commands")[0]?.["commands"], [
			{ name: "fit", description: "FIT board", source: "extension" },
			{ name: "skill:review", description: "Review the diff", source: "skill" },
		]);
		assert.equal((await records(paths)).filter((record) => record["type"] === "get_commands").length, 1);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("mirrors the pending queue and restores it on clear_queue", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, {
			FAKE_PI_SESSION_ID: OLD_ID,
			FAKE_PI_FOLLOW_UP: JSON.stringify(["summarize when finished"]),
		});
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		const queueEvents = () =>
			framesOf(inbox, "event")
				.map((frame) => frame["ev"] as { type?: string; steering?: string[]; followUp?: string[] })
				.filter((event) => event?.type === "queue_update");

		inbox.ws.send(JSON.stringify({ t: "steer", text: "change direction" }));
		await waitFor(() => queueEvents().some((event) => event.steering?.[0] === "change direction"));
		assert.deepEqual(queueEvents().at(-1)?.followUp, ["summarize when finished"]);

		inbox.ws.send(JSON.stringify({ t: "clear_queue" }));
		await waitFor(() => framesOf(inbox, "queue").length > 0);
		const cleared = framesOf(inbox, "queue").at(-1);
		assert.deepEqual(cleared?.["steering"], ["change direction"]);
		assert.deepEqual(cleared?.["followUp"], ["summarize when finished"]);
		// The fixture emits a fresh complete event, so the chips clear themselves.
		await waitFor(() =>
			queueEvents().some((event) => (event.steering ?? []).length === 0 && (event.followUp ?? []).length === 0),
		);
		assert.equal((await records(paths)).filter((record) => record["type"] === "clear_queue").length, 1);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("answers copy with Pi's last assistant text", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID, FAKE_PI_LAST_TEXT: "the last answer" });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "copy" }));
		await waitFor(() => framesOf(inbox, "copy").length > 0);
		assert.equal(framesOf(inbox, "copy")[0]?.["text"], "the last answer");

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("resolves /model and /thinking arguments and toasts when they are unknown", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "set_model_query", query: "acme/other-model" }));
		await waitFor(() => framesOf(inbox, "status").some((frame) => (frame["session"] as { model?: string })?.model === "other-model"));
		const setModel = (await records(paths)).find((record) => record["type"] === "set_model");
		assert.deepEqual({ provider: setModel?.["provider"], id: setModel?.["modelId"] }, { provider: "acme", id: "other-model" });

		inbox.ws.send(JSON.stringify({ t: "set_model_query", query: "deepseek" }));
		await waitFor(() => framesOf(inbox, "error").length > 0);
		assert.match(String(framesOf(inbox, "error")[0]?.["message"]), /unknown model/);

		inbox.ws.send(JSON.stringify({ t: "set_thinking_query", query: "med" }));
		await waitFor(() => framesOf(inbox, "status").some((frame) => (frame["session"] as { thinkingLevel?: string })?.thinkingLevel === "medium"));
		const thinking = (await records(paths)).find((record) => record["type"] === "set_thinking_level");
		assert.equal(thinking?.["level"], "medium");

		inbox.ws.send(JSON.stringify({ t: "set_thinking_query", query: "turbo" }));
		await waitFor(() => framesOf(inbox, "error").length > 1);
		assert.match(String(framesOf(inbox, "error")[1]?.["message"]), /unknown thinking level/);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		await waitFor(() =>
			framesOf(inbox, "event").some((frame) => (frame["ev"] as { type?: string })?.type === "compaction_end"),
		);
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
		await waitFor(() =>
			framesOf(inbox, "status").some((frame) => (frame["session"] as { name?: string })?.name === "dogfood"),
		);
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
		assert.equal(
			(await records(paths)).some((record) => record["type"] === "new_session"),
			true,
		);

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

	it("sends a steer as prompt+steer and leaves an idle session idle", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const id = decodeURIComponent(url.split("session=")[1] ?? "");

		// RPC `steer` only queues, so a steer arriving while Pi is idle would never
		// run and the hub would latch "busy" with no agent_settled to clear it.
		await hub.steer(id, "change direction");

		const sent = (await records(paths)).filter((record) => record["type"] === "prompt" || record["type"] === "steer");
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.["type"], "prompt");
		assert.equal(sent[0]?.["streamingBehavior"], "steer");
		assert.equal(sent[0]?.["text"], "change direction");
		assert.equal((await hub.list()).find((session) => session.id === id)?.state, "idle");

		await server.close();
		await hub.shutdown();
	});

	it("forks from a user message and re-keys the live session", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, {
			FAKE_PI_SESSION_ID: OLD_ID,
			FAKE_PI_FORK_SESSION_ID: NEW_ID,
			FAKE_PI_FORK_TEXT: "fix the parser bug",
		});
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "fork", entryId: "e1" }));
		await waitFor(() => framesOf(inbox, "opened").some((frame) => frame["rekey"] === true));
		assert.equal((framesOf(inbox, "opened").at(-1)?.["session"] as { id?: string })?.id, NEW_ID);
		await waitFor(() => framesOf(inbox, "fork").length > 0);
		const fork = framesOf(inbox, "fork").at(-1);
		assert.equal(fork?.["cancelled"], false);
		assert.equal(fork?.["text"], "fix the parser bug");

		// The socket's active id followed the re-key; the client can resnapshot.
		const snapshots = framesOf(inbox, "snapshot").length;
		inbox.ws.send(JSON.stringify({ t: "resnapshot" }));
		await waitFor(() => framesOf(inbox, "snapshot").length > snapshots);

		const record = (JSON.parse(await readFile(paths.indexPath, "utf8")) as Array<Record<string, unknown>>).find(
			(entry) => entry["logicalId"],
		);
		assert.equal(record?.["piId"], NEW_ID);
		assert.deepEqual(record?.["piIds"], [OLD_ID, NEW_ID]);
		const logged = (await records(paths)).find((entry) => entry["type"] === "fork");
		assert.equal(logged?.["entryId"], "e1");

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("clones the active branch and follows the new id", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, {
			FAKE_PI_SESSION_ID: OLD_ID,
			FAKE_PI_CLONE_SESSION_ID: NEW_ID,
		});
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "clone" }));
		await waitFor(() => framesOf(inbox, "opened").some((frame) => frame["rekey"] === true));
		assert.equal((framesOf(inbox, "opened").at(-1)?.["session"] as { id?: string })?.id, NEW_ID);
		await waitFor(() => framesOf(inbox, "clone").length > 0);
		assert.equal(framesOf(inbox, "clone")[0]?.["cancelled"], false);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("answers /tree with the read-only tree and current leaf", async () => {
		const paths = await fixtureRoot();
		const TREE = {
			tree: [
				{
					entry: {
						type: "message",
						id: "u1",
						parentId: null,
						message: { role: "user", content: [{ type: "text", text: "first" }] },
					},
					label: "main",
					children: [
						{
							entry: { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } },
							children: [],
						},
					],
				},
			],
			leafId: "a1",
		};
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID, FAKE_PI_TREE: JSON.stringify(TREE) });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "tree" }));
		await waitFor(() => framesOf(inbox, "tree").length > 0);
		const frame = framesOf(inbox, "tree")[0];
		assert.deepEqual(frame?.["tree"], TREE.tree);
		assert.equal(frame?.["leafId"], "a1");
		assert.equal(
			(await records(paths)).some((entry) => entry["type"] === "get_tree"),
			true,
		);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("copies an imported JSONL into the data dir, indexes it and opens it", async () => {
		const paths = await fixtureRoot();
		const IMPORTED_ID = "03c3fd5f-cccc-7664-b952-f6673a2c7a8e";
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: IMPORTED_ID,
			cwd: "/tmp/imported-project",
			timestamp: "2026-11-21T00:00:00.000Z",
		});
		const body =
			[
				header,
				JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } }),
			].join("\n") + "\n";
		const source = join(paths.dir, "foreign.jsonl");
		await writeFile(source, body);

		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		inbox.ws.send(JSON.stringify({ t: "import", path: source }));
		await waitFor(() =>
			framesOf(inbox, "opened").some((frame) => (frame["session"] as { id?: string })?.id === IMPORTED_ID),
		);
		await waitFor(() => framesOf(inbox, "import").length > 0);
		assert.equal(framesOf(inbox, "import")[0]?.["cancelled"], false);

		const copied = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${IMPORTED_ID}.jsonl`);
		assert.equal(await readFile(copied, "utf8"), body);
		assert.equal(await readFile(source, "utf8"), body);

		const index = JSON.parse(await readFile(paths.indexPath, "utf8")) as Array<Record<string, unknown>>;
		assert.equal(
			index.some((record) => record["piId"] === IMPORTED_ID),
			true,
		);
		const listed = await hub.list();
		assert.equal(
			listed.some((session) => session.id === IMPORTED_ID),
			true,
		);
		const switched = (await records(paths)).find((entry) => entry["type"] === "switch_session");
		assert.equal(switched?.["sessionPath"], copied);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("exports HTML and JSONL as attachments", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, { FAKE_PI_SESSION_ID: OLD_ID });
		const inbox = await connect(url);
		await waitFor(() => framesOf(inbox, "snapshot").length > 0);

		// The fake reports a session file path but only writes one when asked; the
		// JSONL download is that file, so create it the way Pi would.
		const sessionFile = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${OLD_ID}.jsonl`);
		const jsonl = '{"type":"session","id":"' + OLD_ID + '"}\n';
		await writeFile(sessionFile, jsonl);

		inbox.ws.send(JSON.stringify({ t: "export" }));
		await waitFor(() => framesOf(inbox, "export").length > 0);
		const frame = framesOf(inbox, "export")[0];
		const base = server.url.replace(/\/$/, "");

		const htmlResponse = await fetch(`${base}${String(frame?.["html"])}`);
		assert.equal(htmlResponse.status, 200);
		assert.match(htmlResponse.headers.get("content-disposition") ?? "", /^attachment; filename=".*\.html"$/);
		assert.match(await htmlResponse.text(), /exported/);

		const jsonlResponse = await fetch(`${base}${String(frame?.["jsonl"])}`);
		assert.equal(jsonlResponse.status, 200);
		assert.match(jsonlResponse.headers.get("content-disposition") ?? "", /^attachment; filename=".*\.jsonl"$/);
		assert.equal(await jsonlResponse.text(), jsonl);
		const exported = (await records(paths)).find((entry) => entry["type"] === "export_html");
		assert.match(String(exported?.["outputPath"]), /\/exports\/.*\.html$/);

		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("answers copy with Pi's last assistant text", async () => {
		const paths = await fixtureRoot();
		const { hub, server, url } = await boot(paths, {
			FAKE_PI_SESSION_ID: OLD_ID,
			FAKE_PI_LAST_TEXT: "the last answer",
		});
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
		await waitFor(() =>
			framesOf(inbox, "status").some((frame) => (frame["session"] as { model?: string })?.model === "other-model"),
		);
		const setModel = (await records(paths)).find((record) => record["type"] === "set_model");
		assert.deepEqual(
			{ provider: setModel?.["provider"], id: setModel?.["modelId"] },
			{ provider: "acme", id: "other-model" },
		);

		inbox.ws.send(JSON.stringify({ t: "set_model_query", query: "deepseek" }));
		await waitFor(() => framesOf(inbox, "error").length > 0);
		assert.match(String(framesOf(inbox, "error")[0]?.["message"]), /unknown model/);

		inbox.ws.send(JSON.stringify({ t: "set_thinking_query", query: "med" }));
		await waitFor(() =>
			framesOf(inbox, "status").some(
				(frame) => (frame["session"] as { thinkingLevel?: string })?.thinkingLevel === "medium",
			),
		);
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

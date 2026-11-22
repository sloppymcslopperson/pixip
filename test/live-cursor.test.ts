import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const SESSION_ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
const roots: string[] = [];

interface Paths {
	dir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
	logPath: string;
	logs: string[];
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-cursor-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		sessionsDir: join(dir, "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "sessions.json"),
		logPath: join(dir, "spawns.jsonl"),
		logs: [],
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

interface EntryMessage {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: { role: string; timestamp: number; content: Array<{ type: string; text: string }> };
}

function entry(id: string, role: string, timestamp: number, text = id): EntryMessage {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role, timestamp, content: [{ type: "text", text }] },
	};
}

function messageEnd(role: string, timestamp: number, text = "live") {
	return { type: "message_end", message: { role, timestamp, content: [{ type: "text", text }] } };
}

async function writeSession(paths: Paths, entries: EntryMessage[]): Promise<string> {
	const path = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		cwd: paths.dir,
		timestamp: "2026-11-21T00:00:00.000Z",
	});
	await writeFile(path, [header, ...entries.map((item) => JSON.stringify(item))].join("\n") + "\n");
	return path;
}

async function boot(paths: Paths, env: Record<string, string>): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		extraPiArgs: [],
		env: { FAKE_PI_LOG: paths.logPath, FAKE_PI_SESSION_ID: SESSION_ID, ...env },
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
	close: () => void;
}

async function connect(url: string): Promise<Inbox> {
	const ws = new WebSocket(url);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
		} catch {
			// a broken frame would fail the assertions below anyway
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { frames, close: () => ws.close() };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for frames");
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshots = (inbox: Inbox) => inbox.frames.filter((frame) => frame["t"] === "snapshot");
const liveMessages = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => (frame["ev"] as { message?: { timestamp?: number } } | undefined)?.message?.timestamp)
		.filter((stamp): stamp is number => typeof stamp === "number");

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("snapshot / live boundary", () => {
	it("drops a buffered record the snapshot already covers", async () => {
		const paths = await fixtureRoot();
		const first = entry("m1", "user", 111);
		const covered = entry("m2", "user", 222);
		await writeSession(paths, [first]);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify([first]),
			FAKE_PI_LEAF: "m2",
			// Pi appends the entry, then emits the event: the event lands between
			// the subscription and the get_entries answer, and the snapshot has it.
			FAKE_PI_DURING_ENTRY: JSON.stringify(covered),
			FAKE_PI_DURING: JSON.stringify([messageEnd("user", 222)]),
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		const authoritative = snapshots(inbox).at(-1);
		const entries = authoritative?.["entries"] as Array<{ id: string }>;
		assert.deepEqual(
			entries.map((item) => item.id),
			["m1", "m2"],
		);
		assert.equal(liveMessages(inbox).includes(222), false);
		assert.ok(snapshots(inbox).length >= 1);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("flushes a buffered record the snapshot does not cover, exactly once", async () => {
		const paths = await fixtureRoot();
		const first = entry("m1", "user", 111);
		await writeSession(paths, [first]);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify([first]),
			FAKE_PI_LEAF: "m1",
			// Appended after the snapshot response, so it is genuinely new.
			FAKE_PI_DURING: JSON.stringify([messageEnd("user", 333)]),
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		const live = liveMessages(inbox);
		assert.equal(live.filter((stamp) => stamp === 333).length, 1);
		assert.equal(live.includes(222), false);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("resumes from the durable cursor and sends only the delta", async () => {
		const paths = await fixtureRoot();
		const entries = [entry("e1", "user", 101), entry("e2", "assistant", 102), entry("e3", "user", 103)];
		await writeSession(paths, entries);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify(entries),
			FAKE_PI_LEAF: "e3",
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}&since=e1`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		const resume = snapshots(inbox)[0];
		assert.equal(resume?.["resume"], true);
		const sent = (resume?.["entries"] as Array<{ id: string }>).map((item) => item.id);
		assert.deepEqual(sent, ["e2", "e3"]);
		// The provisional pre-attach paint is skipped when resuming.
		assert.equal(snapshots(inbox).length, 1);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("falls back to a full snapshot when the cursor is unknown", async () => {
		const paths = await fixtureRoot();
		const entries = [entry("e1", "user", 101), entry("e2", "assistant", 102)];
		await writeSession(paths, entries);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify(entries),
			FAKE_PI_LEAF: "e2",
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}&since=gone`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		const snapshot = snapshots(inbox)[0];
		assert.equal(snapshot?.["resume"], undefined);
		const sent = (snapshot?.["entries"] as Array<{ id: string }>).map((item) => item.id);
		assert.deepEqual(sent, ["e1", "e2"]);
		assert.equal(
			inbox.frames.some((frame) => frame["t"] === "error"),
			false,
		);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});
});

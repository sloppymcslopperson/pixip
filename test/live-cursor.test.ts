import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { cleanupRoots, fixtureRoot, hubFor, waitFor, type TestPaths } from "./helpers/harness.ts";

const SESSION_ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
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

async function writeSession(paths: TestPaths, entries: EntryMessage[]): Promise<string> {
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

async function boot(paths: TestPaths, env: Record<string, string>): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = hubFor(paths, { log: (message) => paths.logs.push(message) }, { FAKE_PI_SESSION_ID: SESSION_ID, ...env });
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
	send: (frame: Record<string, unknown>) => void;
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
	return { frames, send: (frame) => ws.send(JSON.stringify(frame)), close: () => ws.close() };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshots = (inbox: Inbox) => inbox.frames.filter((frame) => frame["t"] === "snapshot");
const liveMessages = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => (frame["ev"] as { message?: { timestamp?: number } } | undefined)?.message?.timestamp)
		.filter((stamp): stamp is number => typeof stamp === "number");

after(async () => {
	await cleanupRoots();
});

describe("snapshot / live boundary", () => {
	it("bounds the initial window from the JSONL and marks truncated entries", async () => {
		const paths = await fixtureRoot("pixip-cursor-");
		const huge = "z".repeat(40_000);
		const first = entry("m1", "user", 111, huge);
		await writeSession(paths, [first]);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify([first]),
			FAKE_PI_LEAF: "m1",
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		const base = snapshots(inbox)[0];
		const entries = base?.["entries"] as Array<{ truncated?: boolean; message: { content: Array<{ text: string }> } }>;
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.truncated, true);
		assert.ok((entries[0]?.message.content[0]?.text.length ?? 0) < huge.length);
		assert.ok(JSON.stringify(base).length < 100_000);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("serves one full entry from the JSONL on demand", async () => {
		const paths = await fixtureRoot("pixip-cursor-");
		const huge = "q".repeat(40_000);
		const first = entry("m1", "user", 111, huge);
		await writeSession(paths, [first]);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify([first]),
			FAKE_PI_LEAF: "m1",
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
		await delay(100);

		inbox.send({ t: "entry", id: "m1" });
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "entry"));
		const answer = inbox.frames.find((frame) => frame["t"] === "entry");
		const full = answer?.["entry"] as { message: { content: Array<{ text: string }> } };
		assert.equal(full.message.content[0]?.text, huge);
		assert.equal(answer?.["error"], undefined);

		inbox.frames.length = 0;
		inbox.send({ t: "entry", id: "missing" });
		await waitFor(() => inbox.frames.some((frame) => frame["t"] === "entry"));
		const missing = inbox.frames.find((frame) => frame["t"] === "entry");
		assert.equal(missing?.["entry"], null);
		assert.match(String(missing?.["error"]), /not on disk/);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("drops a buffered record the snapshot already covers", async () => {
		const paths = await fixtureRoot("pixip-cursor-");
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

		// The first frame is the bounded JSONL window; the second is the cursor
		// delta that closes the gap with Pi's newer entries.
		const byId = new Map<string, unknown>();
		for (const frame of snapshots(inbox)) {
			for (const item of frame["entries"] as Array<{ id: string }>) byId.set(item.id, item);
		}
		assert.deepEqual([...byId.keys()], ["m1", "m2"]);
		assert.equal(liveMessages(inbox).includes(222), false);
		assert.ok(snapshots(inbox).length >= 2);
		inbox.close();
		await server.close();
		await hub.shutdown();
	});

	it("flushes a buffered record the snapshot does not cover, exactly once", async () => {
		const paths = await fixtureRoot("pixip-cursor-");
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
		const paths = await fixtureRoot("pixip-cursor-");
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
		const paths = await fixtureRoot("pixip-cursor-");
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

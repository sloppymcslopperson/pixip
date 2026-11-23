import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { cleanupRoots, fixtureRoot, hubFor, spawns, waitFor, type TestPaths } from "./helpers/harness.ts";

const SESSION_ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
const NEXT_ID = "01a1fb3f-bbbb-7664-b952-f6673a2c7a8c";

interface EntryMessage {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: { role: string; timestamp: number; content: Array<{ type: string; text: string }> };
}

function entry(id: string, role: string, timestamp: number): EntryMessage {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role, timestamp, content: [{ type: "text", text: id }] },
	};
}

function messageEnd(timestamp: number, text = "late") {
	return { type: "message_end", message: { role: "assistant", timestamp, content: [{ type: "text", text }] } };
}

async function writeSession(paths: TestPaths, entries: EntryMessage[]): Promise<void> {
	const path = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		cwd: paths.dir,
		timestamp: "2026-11-21T00:00:00.000Z",
	});
	await writeFile(path, [header, ...entries.map((item) => JSON.stringify(item))].join("\n") + "\n");
}

async function boot(paths: TestPaths, env: Record<string, string> = {}): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = hubFor(paths, { log: () => {} }, { FAKE_PI_SESSION_ID: SESSION_ID, ...env });
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
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
			// assertions below fail on a broken frame anyway
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { frames, send: (frame) => ws.send(JSON.stringify(frame)), close: () => ws.close() };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
	await cleanupRoots();
});

describe("park / resume", () => {
	it("stays attached, sends no session frames while parked, then resumes with a cursor", async () => {
		const paths = await fixtureRoot("pixip-park-", { logName: "rpc.jsonl" });
		const entries = [entry("e1", "user", 101), entry("e2", "assistant", 102)];
		await writeSession(paths, entries);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify(entries),
			FAKE_PI_LEAF: "e2",
			FAKE_PI_SETTLE: JSON.stringify([messageEnd(444)]),
			FAKE_PI_SETTLE_DELAY_MS: "150",
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
			const spawnsBefore = (await spawns(paths)).filter((record) => record["type"] === "spawn").length;

			inbox.send({ t: "prompt", text: "go" });
			inbox.send({ t: "park" });
			await delay(400);
			const parkedAt = inbox.frames.length;
			assert.equal(
				inbox.frames.some(
					(frame) => frame["t"] === "event" && (frame["ev"] as { type?: string })?.type === "message_end",
				),
				false,
			);

			// A command on a parked socket never reaches the child.
			inbox.send({ t: "copy" });
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "error"));
			assert.match(String(inbox.frames.find((frame) => frame["t"] === "error")?.["message"]), /parked/);

			const beforeResume = inbox.frames.length;
			inbox.send({ t: "resume", since: "e1" });
			await waitFor(() =>
				inbox.frames.slice(beforeResume).some((frame) => frame["t"] === "snapshot" && frame["resume"] === true),
			);
			const resume = inbox.frames
				.slice(beforeResume)
				.find((frame) => frame["t"] === "snapshot" && frame["resume"] === true);
			const sent = (resume?.["entries"] as Array<{ id: string }>).map((item) => item.id);
			assert.deepEqual(sent, ["e2"]);
			// The pre-resume frames are the parked error only; no events or list frames.
			const parkedFrames = inbox.frames.slice(parkedAt, beforeResume).filter((frame) => frame["t"] !== "error");
			assert.deepEqual(parkedFrames, []);

			const spawnsAfter = (await spawns(paths)).filter((record) => record["type"] === "spawn").length;
			assert.equal(spawnsAfter, spawnsBefore, "resume reuses the attached child");
			assert.ok(inbox.frames.some((frame) => frame["t"] === "policy"));
			assert.ok(inbox.frames.some((frame) => frame["t"] === "commands"));
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("tells a parked socket when another tab rekeys the session", async () => {
		const paths = await fixtureRoot("pixip-park-rekey-", { logName: "rpc.jsonl" });
		const entries = [entry("e1", "user", 101)];
		await writeSession(paths, entries);
		const { hub, server } = await boot(paths, {
			FAKE_PI_ENTRIES: JSON.stringify(entries),
			FAKE_PI_LEAF: "e1",
			FAKE_PI_NEW_SESSION_ID_AFTER: NEXT_ID,
		});
		const inbox = await connect(`${server.url}ws?session=${SESSION_ID}`);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "footer"));
			inbox.send({ t: "park" });
			await delay(50);
			await hub.newSession(SESSION_ID);
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "opened"));
			const opened = inbox.frames.find((frame) => frame["t"] === "opened");
			assert.equal(opened?.["rekey"], true);
			assert.equal((opened?.["session"] as { id?: string })?.id, NEXT_ID);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

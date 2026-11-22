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
const roots: string[] = [];

const REQUEST = [
	{
		type: "extension_ui_request",
		id: "ui-1",
		method: "select",
		title: "Pick one",
		options: ["Alpha", "Beta"],
	},
];

interface Paths {
	dir: string;
	dataDir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
	logPath: string;
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-pending-ui-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		dataDir: join(dir, "data"),
		sessionsDir: join(dir, "data", "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "data", "sessions.json"),
		logPath: join(dir, "rpc.jsonl"),
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

async function boot(
	paths: Paths,
	pendingUiGraceMs = 1000,
): Promise<{ hub: Hub; server: RunningServer; id: string; url: string }> {
	const hub = new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		pendingUiGraceMs,
		extraPiArgs: [],
		env: {
			FAKE_PI_LOG: paths.logPath,
			FAKE_PI_ON_PROMPT: JSON.stringify(REQUEST),
		},
		log: () => {},
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	const created = await hub.create(paths.dir);
	return { hub, server, id: created.id, url: server.url };
}

interface Inbox {
	frames: Array<Record<string, unknown>>;
	send: (frame: Record<string, unknown>) => void;
	close: () => void;
}

async function connect(url: string, id: string): Promise<Inbox> {
	const ws = new WebSocket(`${url}ws?session=${encodeURIComponent(id)}`);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
		} catch {
			// the assertions below would fail on a broken frame anyway
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return {
		frames,
		send: (frame) => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
	};
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for frames");
}

const uiRequests = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => frame["ev"] as Record<string, unknown> | undefined)
		.filter(
			(event): event is Record<string, unknown> =>
				event?.type === "extension_ui_request" && event["method"] === "select",
		);

async function loggedResponses(paths: Paths): Promise<Array<Record<string, unknown>>> {
	let text = "";
	try {
		text = await readFile(paths.logPath, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				return record["type"] === "extension_ui_response" ? [record] : [];
			} catch {
				return [];
			}
		});
}

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("pending extension UI", () => {
	it("replays an unanswered dialog after the browser reconnects", async () => {
		const paths = await fixtureRoot();
		const { hub, server, id, url } = await boot(paths);
		const first = await connect(url, id);
		try {
			await waitFor(() => first.frames.some((frame) => frame["t"] === "snapshot"));
			first.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(first).length === 1);
			first.close();

			const second = await connect(url, id);
			try {
				await waitFor(() => uiRequests(second).length === 1);
				const replay = uiRequests(second)[0];
				assert.ok(replay);
				assert.equal(replay["id"], "ui-1");
				assert.equal(replay["title"], "Pick one");
				assert.deepEqual(replay["options"], ["Alpha", "Beta"]);

				second.send({ t: "ui", id: "ui-1", value: "Beta" });
				await waitFor(async () => (await loggedResponses(paths)).some((entry) => entry["id"] === "ui-1"));
			} finally {
				second.close();
			}

			// Answered requests are not replayed to a later tab.
			const third = await connect(url, id);
			try {
				await waitFor(() => third.frames.some((frame) => frame["t"] === "footer"));
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(uiRequests(third).length, 0);
			} finally {
				third.close();
			}
		} finally {
			first.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("cancels a dialog when no client reattaches inside the grace window", async () => {
		const paths = await fixtureRoot();
		const { hub, server, id, url } = await boot(paths, 80);
		const inbox = await connect(url, id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(inbox).length === 1);
			inbox.close();

			await waitFor(async () => (await loggedResponses(paths)).some((entry) => entry["id"] === "ui-1"));
			const response = (await loggedResponses(paths)).find((entry) => entry["id"] === "ui-1");
			assert.equal(response?.["cancelled"], true);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

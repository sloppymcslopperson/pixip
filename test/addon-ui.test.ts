import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const roots: string[] = [];

const ON_PROMPT = [
	{ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "alpha", statusText: "first" },
	{ type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "beta", statusText: "second" },
	{ type: "extension_ui_request", id: "s3", method: "setStatus", statusKey: "alpha", statusText: "updated" },
	{ type: "extension_ui_request", id: "s4", method: "setStatus", statusKey: "beta" },
	{
		type: "extension_ui_request",
		id: "w1",
		method: "setWidget",
		widgetKey: "above",
		widgetLines: ["a1", "a2"],
		widgetPlacement: "aboveEditor",
	},
	{
		type: "extension_ui_request",
		id: "w2",
		method: "setWidget",
		widgetKey: "below",
		widgetLines: ["b1"],
		widgetPlacement: "belowEditor",
	},
	{ type: "extension_ui_request", id: "w3", method: "setWidget", widgetKey: "gone", widgetLines: ["x"] },
	{ type: "extension_ui_request", id: "w4", method: "setWidget", widgetKey: "gone" },
];

interface Paths {
	dir: string;
	dataDir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-addon-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		dataDir: join(dir, "data"),
		sessionsDir: join(dir, "data", "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "data", "sessions.json"),
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

async function boot(paths: Paths): Promise<{ hub: Hub; server: RunningServer; id: string; url: string }> {
	const hub = new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		extraPiArgs: [],
		env: { FAKE_PI_ON_PROMPT: JSON.stringify(ON_PROMPT) },
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

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for frames");
}

const uiRequests = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => frame["ev"] as Record<string, unknown> | undefined)
		.filter((event): event is Record<string, unknown> => event?.type === "extension_ui_request");

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("addon UI cache", () => {
	it("forwards setStatus/setWidget and replays the current keys on a second attach", async () => {
		const paths = await fixtureRoot();
		const { hub, server, id, url } = await boot(paths);
		const first = await connect(url, id);
		try {
			await waitFor(() => first.frames.some((frame) => frame["t"] === "snapshot"));
			first.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(first).length === ON_PROMPT.length);

			const second = await connect(url, id);
			try {
				await waitFor(() => uiRequests(second).length === 3);
				const replay = uiRequests(second);
				assert.deepEqual(
					replay.map((request) => [request["method"], request["statusKey"] ?? request["widgetKey"]]),
					[
						["setWidget", "above"],
						["setStatus", "alpha"],
						["setWidget", "below"],
					],
				);
				assert.equal(replay[1]?.["statusText"], "updated");
				assert.deepEqual(replay[0]?.["widgetLines"], ["a1", "a2"]);
				assert.deepEqual(replay[2]?.["widgetLines"], ["b1"]);
			} finally {
				second.close();
			}

			await hub.stop(id);
			assert.deepEqual(hub.addonUiFrames(id), []);
		} finally {
			first.close();
			await server.close();
		}
	});
});

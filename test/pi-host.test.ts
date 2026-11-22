import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { HOST_FIXTURE, cleanupRoots, fixtureRoot, hubFor, spawns, waitFor, type TestPaths } from "./helpers/harness.ts";

const PANEL = {
	type: "extension_ui_request",
	id: "panel-1",
	method: "panel",
	payload: { title: "Review changes", mode: "inline" },
};

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
			// assertions would fail on a broken frame anyway
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

async function boot(
	paths: TestPaths,
	events: unknown[],
	viaHost = true,
	name: string | null = "host session",
): Promise<{ hub: Hub; server: RunningServer; id: string; url: string }> {
	const hub = hubFor(paths, {
		...(viaHost ? { piHostBin: HOST_FIXTURE } : {}),
		pendingUiGraceMs: 1000,
		env: { FAKE_HOST_LOG: paths.logPath, FAKE_HOST_ON_PROMPT: JSON.stringify(events) },
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	const created = await hub.create(paths.dir, name ?? undefined);
	return { hub, server, id: created.id, url: server.url };
}

const events = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => frame["ev"] as Record<string, unknown> | undefined)
		.filter((event): event is Record<string, unknown> => event !== undefined);

after(async () => {
	await cleanupRoots();
});

describe("pixip-pi-host backend", () => {
	it("consumes hello, forwards events, replays a panel and answers it once", async () => {
		const paths = await fixtureRoot("pixip-host-", { logName: "host.jsonl" });
		const { hub, server, id, url } = await boot(paths, [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "user", content: "go" } },
			PANEL,
		]);
		const first = await connect(url, id);
		try {
			await waitFor(() => first.frames.some((frame) => frame["t"] === "snapshot"));
			// The host handshake is not transcript data.
			assert.equal(
				events(first).some((event) => event.type === "hello"),
				false,
			);
			const spawn = (await spawns(paths)).find((record) => record["type"] === "spawn");
			const args = spawn?.["args"] as string[];
			assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--session-dir"]);

			first.send({ t: "prompt", text: "go" });
			await waitFor(() => events(first).some((event) => event.method === "panel"));

			first.close();
			const second = await connect(url, id);
			try {
				await waitFor(() => events(second).some((event) => event.method === "panel"));
				const replay = events(second).find((event) => event.method === "panel");
				assert.deepEqual(replay?.payload, { title: "Review changes", mode: "inline" });
				second.send({ t: "ui", id: "panel-1", value: '{"action":"ok"}' });
				await waitFor(async () =>
					(await spawns(paths)).some(
						(record) =>
							record["type"] === "extension_ui_response" &&
							record["id"] === "panel-1" &&
							record["value"] === '{"action":"ok"}',
					),
				);
			} finally {
				second.close();
			}

			const third = await connect(url, id);
			try {
				await waitFor(() => third.frames.some((frame) => frame["t"] === "footer"));
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(
					events(third).some((event) => event.method === "panel"),
					false,
				);
			} finally {
				third.close();
			}

			await hub.stop(id);
			await waitFor(async () => (await hub.list()).find((info) => info.id === id)?.state === "stopped");
		} finally {
			first.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("labels sessions through the host print path, not the legacy --pi child", async () => {
		const paths = await fixtureRoot("pixip-host-title-", { logName: "host.jsonl" });
		const { hub, server, id, url } = await boot(
			paths,
			[{ type: "message_start", message: { role: "user", content: "Fix the login bug" } }],
			true,
			null,
		);
		const inbox = await connect(url, id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.send({ t: "prompt", text: "Fix the login bug" });
			await waitFor(async () => (await spawns(paths)).some((record) => record["type"] === "title"));
			const title = (await spawns(paths)).find((record) => record["type"] === "title");
			const args = title?.["args"] as string[];
			assert.equal(args.length, 4);
			assert.deepEqual(args.slice(0, 3), ["--print", "--model", "fake/fake-model"]);
			assert.equal(title?.["model"], "fake/fake-model");
			await waitFor(async () =>
				(await hub.list()).some((info) => info.id === id && info.name === "Host session label"),
			);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

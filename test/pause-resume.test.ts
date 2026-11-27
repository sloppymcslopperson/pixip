import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import type { SessionInfo } from "../src/wire.ts";
import {
	PAUSE_PROMPT,
	RESUME_PROMPT,
	pauseTargets,
	resumePaused,
	takePauseSet,
	writePauseSet,
} from "../src/reload/pause.ts";
import { cleanupRoots, fixtureRoot, hubFor, spawns, waitFor, type TestPaths } from "./helpers/harness.ts";

after(async () => {
	await cleanupRoots();
});

function session(id: string, logicalId: string, state: SessionInfo["state"], name?: string): SessionInfo {
	return {
		id,
		logicalId,
		cwd: "/tmp",
		state,
		peers: [],
		lastActivity: 0,
		...(name ? { name } : {}),
	};
}

describe("pause plan", () => {
	it("maps gate blockers to logical ids and dedupes", () => {
		const targets = pauseTargets(
			[
				{ id: "child-1", name: "One", reason: "busy" },
				{ id: "logical-2", name: "Two", reason: "running bash" },
			],
			[session("child-1", "logical-1", "busy", "One"), session("child-2", "logical-2", "busy", "Two")],
		);
		assert.deepEqual(
			targets.map((target) => [target.id, target.logicalId, target.state]),
			[
				["child-1", "logical-1", "busy"],
				["child-2", "logical-2", "busy"],
			],
		);
	});

	it("round-trips the persisted pause set and consumes it once", async () => {
		const paths = await fixtureRoot("pixip-pause-set-");
		await writePauseSet(paths.dataDir, [{ id: "child-1", logicalId: "logical-1", name: "One", state: "busy" }]);
		const first = await takePauseSet(paths.dataDir);
		assert.equal(first.length, 1);
		assert.equal(first[0]?.logicalId, "logical-1");
		assert.deepEqual(await takePauseSet(paths.dataDir), []);
	});

	it("resumes only live idle/stopped sessions and names every skip", async () => {
		const steered: Array<[string, string]> = [];
		const hub = {
			list: () =>
				Promise.resolve([
					session("child-idle", "logical-idle", "idle", "Idle"),
					session("child-busy", "logical-busy", "busy", "Busy"),
					session("child-error", "logical-error", "error", "Broken"),
					session("child-renamed", "logical-changed", "idle", "Renamed"),
				]),
			steer: (id: string, text: string) => {
				steered.push([id, text]);
				return Promise.resolve();
			},
		};
		const report = await resumePaused(hub, [
			{ id: "child-idle", logicalId: "logical-idle", state: "idle" },
			{ id: "child-busy", logicalId: "logical-busy", state: "busy" },
			{ id: "child-error", logicalId: "logical-error", state: "idle" },
			{ id: "child-renamed", logicalId: "logical-old", state: "idle" },
			{ id: "gone", logicalId: "logical-gone", state: "idle" },
		]);
		assert.deepEqual(steered, [["child-idle", RESUME_PROMPT]]);
		assert.deepEqual(report.resumed, ["Idle"]);
		assert.deepEqual(
			report.skipped.map((entry) => [entry.name, entry.reason]),
			[
				["Busy", "busy"],
				["Broken", "error"],
				["Renamed", "logical id changed"],
				[undefined, "not live"],
			],
		);
	});
});

async function boot(
	paths: TestPaths,
	options: {
		pauseWaitMs?: number;
		restart?: (pause?: import("../src/reload/pause.ts").PauseTarget[]) => Promise<void>;
	} = {},
): Promise<{ hub: Hub; server: Awaited<ReturnType<typeof startServer>> }> {
	const hub = hubFor(paths, { env: { FAKE_PI_IS_STREAMING: "1" } });
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: (message) => paths.logs.push(message),
		...(options.pauseWaitMs ? { pauseWaitMs: options.pauseWaitMs } : {}),
		...(options.restart ? { restart: options.restart } : {}),
	});
	return { hub, server };
}

function nonceFrom(html: string): string {
	return /<meta name="pixip-reload-nonce" content="([^"]+)"/.exec(html)?.[1] ?? "";
}

async function connect(
	url: string,
): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>>; close: () => void }> {
	const ws = new WebSocket(url);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)));
		} catch {
			// assertions only inspect valid frames
		}
	});
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return { ws, frames, close: () => ws.close() };
}

describe("pause/resume steering", () => {
	it("pauses blockers, times out, then restarts without waiting when forced", async () => {
		const paths = await fixtureRoot("pixip-pause-restart-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const restarts: Array<import("../src/reload/pause.ts").PauseTarget[] | undefined> = [];
		const { hub, server } = await boot(paths, {
			pauseWaitMs: 150,
			restart: (pause) => {
				restarts.push(pause);
				return Promise.resolve();
			},
		});
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server.url}ws?session=${encodeURIComponent(created.id)}`);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			const nonce = nonceFrom(await (await fetch(server.url)).text());
			inbox.ws.send(JSON.stringify({ t: "restart", nonce, force: true, pause: true }));
			await waitFor(() => inbox.frames.some((frame) => frame["status"] === "pause-timeout"));
			const timeout = inbox.frames.find((frame) => frame["status"] === "pause-timeout");
			assert.match(String(timeout?.["text"]), /still busy after 0s/);
			assert.equal(restarts.length, 0);
			const logged = await spawns(paths);
			assert.ok(logged.some((record) => record["type"] === "prompt" && record["text"] === PAUSE_PROMPT));

			inbox.ws.send(JSON.stringify({ t: "restart", nonce, force: true, pause: true, now: true }));
			await waitFor(() => inbox.frames.some((frame) => frame["status"] === "ok"));
			assert.equal(restarts.length, 1);
			assert.equal(restarts[0]?.[0]?.logicalId, created.logicalId);
		} finally {
			inbox.close();
			await hub.stop(created.id).catch(() => {});
			await server.close();
			await hub.shutdown();
		}
	});

	it("offers the pause opt-in from a reload refusal and steers on opt-in", async () => {
		const paths = await fixtureRoot("pixip-pause-reload-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { pauseWaitMs: 150 });
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server.url}ws?session=${encodeURIComponent(created.id)}`);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			const nonce = nonceFrom(await (await fetch(server.url)).text());
			inbox.ws.send(JSON.stringify({ t: "reload", nonce }));
			await waitFor(() => inbox.frames.some((frame) => frame["status"] === "refused"));
			const refusal = inbox.frames.find((frame) => frame["status"] === "refused");
			assert.equal(refusal?.["pause"], true);
			assert.equal(refusal?.["pauseKind"], "reload");
			assert.ok(Array.isArray(refusal?.["blockers"]));

			inbox.ws.send(JSON.stringify({ t: "reload", nonce, pause: true }));
			await waitFor(() => inbox.frames.some((frame) => frame["status"] === "pause-timeout"));
			const timeout = inbox.frames.find((frame) => frame["status"] === "pause-timeout");
			assert.equal(timeout?.["pauseKind"], "reload");
			const health = await (await fetch(new URL("health", server.url))).json();
			assert.equal(health["reloads"], 0);
			const logged = await spawns(paths);
			assert.ok(logged.some((record) => record["type"] === "prompt" && record["text"] === PAUSE_PROMPT));
		} finally {
			inbox.close();
			await hub.stop(created.id).catch(() => {});
			await server.close();
			await hub.shutdown();
		}
	});

	it("removes the pause requests when the card cancels with resume", async () => {
		const paths = await fixtureRoot("pixip-pause-cancel-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { pauseWaitMs: 150 });
		const created = await hub.create(paths.dir);
		const inbox = await connect(`${server.url}ws?session=${encodeURIComponent(created.id)}`);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			const nonce = nonceFrom(await (await fetch(server.url)).text());
			inbox.ws.send(JSON.stringify({ t: "reload", nonce, pause: true }));
			await waitFor(() => inbox.frames.some((frame) => frame["status"] === "pause-timeout"));

			inbox.ws.send(JSON.stringify({ t: "pause_cancel", nonce, mode: "resume" }));
			await waitFor(() => inbox.frames.some((frame) => frame["pauseResult"] === true));
			const result = inbox.frames.find((frame) => frame["pauseResult"] === true);
			assert.deepEqual(
				(result?.["skipped"] as Array<{ reason: string }> | undefined)?.map((entry) => entry.reason),
				["busy"],
			);
			const logged = await spawns(paths);
			assert.ok(logged.some((record) => record["type"] === "prompt" && record["text"] === RESUME_PROMPT) === false);
		} finally {
			inbox.close();
			await hub.stop(created.id).catch(() => {});
			await server.close();
			await hub.shutdown();
		}
	});
});

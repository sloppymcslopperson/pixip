import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import {
	FIXTURE,
	HOST_FIXTURE,
	cleanupRoots,
	fixtureRoot,
	hubFor,
	infoEntry,
	sessionFile,
	spawns,
	waitFor,
	type TestPaths,
} from "./helpers/harness.ts";

async function boot(
	paths: TestPaths,
	options: { dev?: boolean; host?: boolean; env?: Record<string, string>; restart?: () => Promise<void> } = {},
): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = hubFor(paths, {
		...(options.host ? { piHostBin: HOST_FIXTURE } : {}),
		env: { FAKE_HOST_LOG: paths.logPath, ...options.env },
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: (message) => paths.logs.push(message),
		dev: options.dev ?? false,
		...(options.restart ? { restart: options.restart } : {}),
	});
	return { hub, server };
}

async function page(url: string): Promise<string> {
	return await (await fetch(url)).text();
}

function nonceFrom(html: string): string {
	const match = /<meta name="pixip-reload-nonce" content="([^"]+)"/.exec(html);
	return match?.[1] ?? "";
}

interface Inbox {
	frames: Array<Record<string, unknown>>;
	ws: WebSocket;
	close: () => void;
}

async function connect(url: string, session?: string): Promise<Inbox> {
	const target = session ? `${url}ws?session=${encodeURIComponent(session)}` : `${url}ws`;
	const ws = new WebSocket(target);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
		} catch {
			// assertions below only inspect valid frames
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { frames, ws, close: () => ws.close() };
}

after(async () => {
	await cleanupRoots();
});

describe("daemon-wide /reload", () => {
	it("refuses while a session is busy and changes nothing", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { env: { FAKE_PI_IS_STREAMING: "1" } });
		try {
			const created = await hub.create(paths.dir);
			const report = await server.reload();
			assert.equal(report.ok, false);
			assert.equal(report.status, "refused");
			assert.equal(report.blockers.length, 1);
			assert.match(report.blockers[0]?.reason ?? "", /busy/);
			assert.equal(report.reloads, 0);
			assert.match(await page(server.url), /v1/);
			assert.equal((await spawns(paths)).filter((record) => record["type"] === "reload").length, 0);
			await hub.stop(created.id).catch(() => {});
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("swaps assets, rotates the nonce and reloads every host child", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { host: true });
		const created = await hub.create(paths.dir);
		const inbox = await connect(server.url);
		try {
			const before = nonceFrom(await page(server.url));
			assert.ok(before);
			await writeFile(join(paths.clientDir, "index.html"), "v2");

			const report = await server.reload();
			assert.equal(report.ok, true);
			assert.equal(report.status, "ok");
			assert.equal(report.reloads, 1);
			assert.match(await page(server.url), /v2/);
			assert.notEqual(nonceFrom(await page(server.url)), before);
			await waitFor(async () => (await spawns(paths)).some((record) => record["type"] === "reload"));
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "notice"));
			const notice = inbox.frames.find((frame) => frame["t"] === "notice");
			assert.equal(notice?.["reload"], true);
			assert.match(String(notice?.["text"]), /reloaded assets/);
			assert.ok(created.id);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("keeps the old assets when the config preflight fails", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		await mkdir(paths.dir, { recursive: true });
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths);
		try {
			await hub.create(paths.dir);
			await writeFile(join(paths.dataDir, "pixip.json"), "{ not json");
			await writeFile(join(paths.clientDir, "index.html"), "v2");
			const report = await server.reload();
			assert.equal(report.ok, false);
			assert.equal(report.status, "error");
			assert.equal(report.reloads, 0);
			assert.match(await page(server.url), /v1/);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("reports a failed child but keeps the new assets", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { host: true, env: { FAKE_HOST_RELOAD_FAIL: "1" } });
		try {
			await hub.create(paths.dir);
			await writeFile(join(paths.clientDir, "index.html"), "v2");
			const report = await server.reload();
			assert.equal(report.ok, false);
			assert.equal(report.status, "partial");
			assert.equal(report.children.length, 1);
			assert.equal(report.children[0]?.ok, false);
			assert.match(await page(server.url), /v2/);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("migrates a system-pi session to the host", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		const file = await sessionFile(paths, [infoEntry("Migrate")]);
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const hub = hubFor(paths, { piBin: FIXTURE, env: { FAKE_HOST_LOG: paths.logPath } });
		const server = await startServer({
			host: "127.0.0.1",
			port: 0,
			hub,
			clientDir: paths.clientDir,
			log: () => {},
		});
		try {
			await hub.attach(file.id);
			(hub as unknown as { options: Record<string, unknown> }).options["piHostBin"] = HOST_FIXTURE;
			const report = await server.reload();
			assert.equal(report.ok, true);
			assert.equal(report.children[0]?.migrated, true);
			const backend = (hub as unknown as { live: Map<string, { backend?: string }> }).live.get(file.id)?.backend;
			assert.equal(backend, "host");
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("rejects a stale browser nonce without reloading", async () => {
		const paths = await fixtureRoot("pixip-reload-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		const { hub, server } = await boot(paths, { host: true });
		const created = await hub.create(paths.dir);
		const inbox = await connect(server.url, created.id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.ws.send(JSON.stringify({ t: "reload", nonce: "stale" }));
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "notice"));
			const notice = inbox.frames.find((frame) => frame["t"] === "notice");
			assert.match(String(notice?.["text"]), /stale nonce/);
			assert.equal(notice?.["reload"], undefined);
			const health = (await (await fetch(new URL("health", server.url))).json()) as Record<string, unknown>;
			assert.equal(health["reloads"], 0);

			// The served meta tag is the accepted capability.
			inbox.ws.send(JSON.stringify({ t: "reload", nonce: nonceFrom(await page(server.url)) }));
			await waitFor(() => inbox.frames.filter((frame) => frame["t"] === "notice").length >= 2);
			assert.equal((await server.reload()).ok, true);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

describe("/pixup-restart", () => {
	it("refuses with the blocking sessions unless force is set", async () => {
		const paths = await fixtureRoot("pixip-restart-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		let restarted = false;
		const { hub, server } = await boot(paths, {
			env: { FAKE_PI_IS_STREAMING: "1" },
			restart: () => {
				restarted = true;
				return Promise.resolve();
			},
		});
		const created = await hub.create(paths.dir);
		const inbox = await connect(server.url, created.id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.ws.send(JSON.stringify({ t: "restart", nonce: nonceFrom(await page(server.url)) }));
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "notice"));
			const refusal = inbox.frames.find((frame) => frame["t"] === "notice");
			assert.equal(refusal?.["restart"], true);
			assert.equal(refusal?.["status"], "refused");
			assert.match(String(refusal?.["text"]), /restart refused/);
			assert.equal((refusal?.["blockers"] as unknown[]).length, 1);
			assert.equal(restarted, false);

			inbox.ws.send(JSON.stringify({ t: "restart", nonce: nonceFrom(await page(server.url)), force: true }));
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "notice" && frame["status"] === "ok"));
			assert.equal(restarted, true);
		} finally {
			inbox.close();
			await hub.stop(created.id).catch(() => {});
			await server.close();
			await hub.shutdown();
		}
	});

	it("rejects a stale nonce without invoking the restart helper", async () => {
		const paths = await fixtureRoot("pixip-restart-");
		await writeFile(join(paths.clientDir, "index.html"), "v1");
		let restarted = false;
		const { hub, server } = await boot(paths, {
			restart: () => {
				restarted = true;
				return Promise.resolve();
			},
		});
		const inbox = await connect(server.url);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "hello"));
			inbox.ws.send(JSON.stringify({ t: "restart", nonce: "stale" }));
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "notice"));
			const notice = inbox.frames.find((frame) => frame["t"] === "notice");
			assert.match(String(notice?.["text"]), /stale nonce/);
			assert.equal(restarted, false);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const roots: string[] = [];

interface Paths {
	dir: string;
	dataDir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
	logPath: string;
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-archive-"));
	roots.push(dir);
	const paths: Paths = {
		dir,
		dataDir: join(dir, "data"),
		sessionsDir: join(dir, "data", "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dir, "data", "sessions.json"),
		logPath: join(dir, "spawns.jsonl"),
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

function hubFor(paths: Paths, env: Record<string, string> = {}, trashGraceMs?: number): Hub {
	return new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		trashGraceMs,
		extraPiArgs: [],
		env: { FAKE_PI_LOG: paths.logPath, ...env },
		log: () => {},
	});
}

async function writeSession(paths: Paths, id: string, name: string): Promise<string> {
	const path = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${id}.jsonl`);
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		cwd: paths.dir,
		timestamp: "2026-11-21T00:00:00.000Z",
	});
	const info = JSON.stringify({
		type: "session_info",
		id: "i1",
		parentId: null,
		timestamp: "2026-11-21T00:00:01.000Z",
		name,
	});
	await writeFile(path, [header, info].join("\n") + "\n");
	return path;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("archive and trash", () => {
	it("archives a stopped session out of the active store and restores it", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "keep me");
		const file = await writeSession(paths, created.id, "keep me");
		await hub.stop(created.id);

		const archived = await hub.archive(created.id);
		assert.equal(archived.state, "stopped");
		assert.equal((await hub.list()).some((session) => session.id === created.id), false);
		assert.equal(await exists(file), false);

		const items = await hub.listArchived();
		assert.equal(items.length, 1);
		assert.equal(items[0]?.logicalId, created.logicalId);
		assert.equal(items[0]?.name, "keep me");

		const restored = await hub.restoreArchived(created.logicalId ?? created.id);
		assert.equal(restored.logicalId, created.logicalId);
		assert.equal((await hub.list()).some((session) => session.logicalId === created.logicalId), true);
		assert.equal(await exists(file), true);
		assert.deepEqual(await hub.listArchived(), []);
		await hub.shutdown();
	});

	it("deletes into trash, restores from the undo token and purges explicitly", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "delete me");
		const file = await writeSession(paths, created.id, "delete me");
		await hub.stop(created.id);

		const deleted = await hub.deleteSession(created.id);
		assert.equal(deleted.token, created.logicalId);
		assert.equal((await hub.list()).some((session) => session.id === created.id), false);
		assert.equal(await exists(file), false);
		const trash = await hub.listTrash();
		assert.equal(trash.length, 1);
		assert.ok((trash[0]?.expiresAt ?? 0) > Date.now());

		const restored = await hub.restoreTrash(deleted.token);
		assert.equal((await hub.list()).some((session) => session.id === restored.id), true);
		assert.equal(await exists(file), true);
		assert.deepEqual(await hub.listTrash(), []);

		const again = await hub.deleteSession(restored.id);
		await hub.purgeTrash(again.token);
		assert.deepEqual(await hub.listTrash(), []);
		await hub.shutdown();
	});

	it("auto-purges trash after the grace period", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths, {}, 25);
		const created = await hub.create(paths.dir, "short lived");
		await writeSession(paths, created.id, "short lived");
		await hub.stop(created.id);
		await hub.deleteSession(created.id);
		await waitFor(async () => (await hub.listTrash()).length === 0);
		await hub.shutdown();
	});

	it("archives only stopped sessions and refuses a busy one", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths);
		const first = await hub.create(paths.dir, "one");
		const second = await hub.create(paths.dir, "two");
		await writeSession(paths, first.id, "one");
		await writeSession(paths, second.id, "two");
		await hub.stop(first.id);
		await hub.stop(second.id);
		const live = await hub.create(paths.dir, "live");

		const result = await hub.archiveInactive();
		assert.equal(result.archived.length, 2);
		assert.deepEqual(result.failed, []);
		const listed = await hub.list();
		assert.equal(listed.some((session) => session.id === first.id), false);
		assert.equal(listed.some((session) => session.id === second.id), false);
		assert.equal(listed.some((session) => session.id === live.id), true);
		await hub.shutdown();

		const busyPaths = await fixtureRoot();
		const busyHub = hubFor(busyPaths, { FAKE_PI_IS_STREAMING: "1" });
		const busy = await busyHub.create(busyPaths.dir, "busy");
		assert.equal(busy.state, "busy");
		await assert.rejects(busyHub.archive(busy.id), /busy/);
		await assert.rejects(busyHub.deleteSession(busy.id), /busy/);
		await busyHub.shutdown();
	});
});

describe("archive REST routes", () => {
	it("serves archive, restore, delete, trash restore and bulk archive", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths);
		let server: RunningServer | undefined;
		try {
			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				hub,
				clientDir: paths.clientDir,
				log: () => {},
			});
			const base = server.url;
			const post = (path: string, method = "POST") => fetch(new URL(path, base), { method });
			const get = async (path: string) => (await fetch(new URL(path, base))).json();

			const one = await hub.create(paths.dir, "one");
			await writeSession(paths, one.id, "one");
			await hub.stop(one.id);
			assert.equal((await post(`api/sessions/${one.id}/archive`)).status, 200);
			assert.deepEqual(await get("api/sessions"), []);
			assert.equal(((await get("api/archived")) as unknown[]).length, 1);
			assert.equal((await post(`api/archived/${one.logicalId}/restore`)).status, 200);
			assert.equal(((await get("api/sessions")) as unknown[]).length, 1);

			const deletedResponse = await post(`api/sessions/${one.id}`, "DELETE");
			assert.equal(deletedResponse.status, 200);
			const deleted = (await deletedResponse.json()) as { undo: { token: string } };
			assert.equal(((await get("api/trash")) as unknown[]).length, 1);
			assert.equal((await post(`api/trash/${deleted.undo.token}/restore`)).status, 200);
			assert.equal(((await get("api/trash")) as unknown[]).length, 0);

			// Two stopped sessions for the bulk route; the restored one is stopped too.
			const two = await hub.create(paths.dir, "two");
			await writeSession(paths, two.id, "two");
			await hub.stop(two.id);
			const bulk = (await (await post("api/sessions/archive-inactive")).json()) as { archived: number };
			assert.equal(bulk.archived, 2);
			assert.equal(((await get("api/sessions")) as unknown[]).length, 0);
			assert.equal(((await get("api/archived")) as unknown[]).length, 2);
		} finally {
			await server?.close();
			await hub.shutdown();
		}
	});
});

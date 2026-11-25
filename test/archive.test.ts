import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import {
	cleanupRoots,
	exists,
	fixtureRoot,
	hubFor as harnessHubFor,
	infoEntry,
	sessionFile,
	waitFor,
	type TestPaths,
} from "./helpers/harness.ts";

function hubFor(paths: TestPaths, env: Record<string, string> = {}, trashGraceMs?: number): Hub {
	return harnessHubFor(paths, { trashGraceMs }, env);
}

async function writeSession(paths: TestPaths, id: string, name: string): Promise<string> {
	const { path } = await sessionFile(paths, [infoEntry(name)], { id, cwd: paths.dir });
	return path;
}

after(async () => {
	await cleanupRoots();
});

describe("archive and trash", () => {
	it("archives a stopped session out of the active store and restores it", async () => {
		const paths = await fixtureRoot("pixip-archive-");
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "keep me");
		const file = await writeSession(paths, created.id, "keep me");
		await hub.stop(created.id);

		const archived = await hub.archive(created.id);
		assert.equal(archived.state, "stopped");
		assert.equal(
			(await hub.list()).some((session) => session.id === created.id),
			false,
		);
		assert.equal(await exists(file), false);

		const items = await hub.listArchived();
		assert.equal(items.length, 1);
		assert.equal(items[0]?.logicalId, created.logicalId);
		assert.equal(items[0]?.name, "keep me");

		const restored = await hub.restoreArchived(created.logicalId ?? created.id);
		assert.equal(restored.logicalId, created.logicalId);
		assert.equal(
			(await hub.list()).some((session) => session.logicalId === created.logicalId),
			true,
		);
		assert.equal(await exists(file), true);
		assert.deepEqual(await hub.listArchived(), []);
		await hub.shutdown();
	});

	it("deletes into trash, restores from the undo token and purges explicitly", async () => {
		const paths = await fixtureRoot("pixip-archive-");
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "delete me");
		const file = await writeSession(paths, created.id, "delete me");
		await hub.stop(created.id);

		const deleted = await hub.deleteSession(created.id);
		assert.equal(deleted.token, created.logicalId);
		assert.equal(
			(await hub.list()).some((session) => session.id === created.id),
			false,
		);
		assert.equal(await exists(file), false);
		const trash = await hub.listTrash();
		assert.equal(trash.length, 1);
		assert.ok((trash[0]?.expiresAt ?? 0) > Date.now());

		const restored = await hub.restoreTrash(deleted.token);
		assert.equal(
			(await hub.list()).some((session) => session.id === restored.id),
			true,
		);
		assert.equal(await exists(file), true);
		assert.deepEqual(await hub.listTrash(), []);

		const again = await hub.deleteSession(restored.id);
		await hub.purgeTrash(again.token);
		assert.deepEqual(await hub.listTrash(), []);
		await hub.shutdown();
	});

	it("auto-purges trash after the grace period", async () => {
		const paths = await fixtureRoot("pixip-archive-");
		const hub = hubFor(paths, {}, 25);
		const created = await hub.create(paths.dir, "short lived");
		await writeSession(paths, created.id, "short lived");
		await hub.stop(created.id);
		await hub.deleteSession(created.id);
		await waitFor(async () => (await hub.listTrash()).length === 0);
		await hub.shutdown();
	});

	it("archives only stopped sessions and refuses a busy one", async () => {
		const paths = await fixtureRoot("pixip-archive-");
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
		assert.equal(
			listed.some((session) => session.id === first.id),
			false,
		);
		assert.equal(
			listed.some((session) => session.id === second.id),
			false,
		);
		assert.equal(
			listed.some((session) => session.id === live.id),
			true,
		);
		await hub.shutdown();

		const busyPaths = await fixtureRoot("pixip-archive-");
		const busyHub = hubFor(busyPaths, { FAKE_PI_IS_STREAMING: "1" });
		const busy = await busyHub.create(busyPaths.dir, "busy");
		assert.equal(busy.state, "busy");
		await assert.rejects(busyHub.archive(busy.id), /busy/);
		await assert.rejects(busyHub.deleteSession(busy.id), /busy/);
		await busyHub.shutdown();
	});

	it("never bulk-archives a protected session, and keeps the flag across archive/restore", async () => {
		const paths = await fixtureRoot("pixip-archive-");
		const hub = hubFor(paths);
		const keep = await hub.create(paths.dir, "keep");
		const gone = await hub.create(paths.dir, "gone");
		await writeSession(paths, keep.id, "keep");
		await writeSession(paths, gone.id, "gone");
		await hub.stop(keep.id);
		await hub.stop(gone.id);

		const protectedInfo = await hub.setProtected(keep.id, true);
		assert.equal(protectedInfo.protected, true);
		assert.equal((await hub.list()).find((session) => session.id === keep.id)?.protected, true);

		const bulk = await hub.archiveInactive([keep.id, gone.id]);
		assert.deepEqual(
			bulk.archived.map((session) => session.id),
			[gone.id],
		);
		const listed = await hub.list();
		assert.equal(
			listed.some((session) => session.id === keep.id),
			true,
		);
		assert.equal(
			listed.some((session) => session.id === gone.id),
			false,
		);

		// A manual archive is still explicit; the flag rides along and comes back.
		await hub.archive(keep.id);
		const archived = (await hub.listArchived()).find((session) => session.logicalId === keep.logicalId);
		assert.equal(archived?.protected, true);
		const restored = await hub.restoreArchived(keep.logicalId ?? keep.id);
		assert.equal(restored.protected, true);

		await hub.setProtected(restored.id, false);
		assert.equal((await hub.list()).find((session) => session.id === restored.id)?.protected, undefined);
		assert.equal((await hub.archiveInactive()).archived.length, 1);
		await hub.shutdown();
	});

	it("archives only the requested ids for a bulk call", async () => {
		const paths = await fixtureRoot("pixip-archive-");
		const hub = hubFor(paths);
		const first = await hub.create(paths.dir, "one");
		const second = await hub.create(paths.dir, "two");
		await writeSession(paths, first.id, "one");
		await writeSession(paths, second.id, "two");
		await hub.stop(first.id);
		await hub.stop(second.id);

		const result = await hub.archiveInactive([first.id]);
		assert.equal(result.archived.length, 1);
		assert.equal(result.archived[0]?.id, first.id);
		assert.deepEqual(result.failed, []);
		const listed = await hub.list();
		assert.equal(
			listed.some((session) => session.id === first.id),
			false,
		);
		assert.equal(
			listed.some((session) => session.id === second.id),
			true,
		);
		await hub.shutdown();
	});
});

describe("archive REST routes", () => {
	it("toggles bulk-archive protection over HTTP", async () => {
		const paths = await fixtureRoot("pixip-archive-");
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
			const create = await hub.create(paths.dir, "pinned");
			await writeSession(paths, create.id, "pinned");
			await hub.stop(create.id);
			const protect = (value: boolean) =>
				fetch(new URL(`api/sessions/${create.id}/protect`, base), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ protected: value }),
				});

			assert.equal((await protect(true)).status, 200);
			const listed = (await (await fetch(new URL("api/sessions", base))).json()) as Array<{
				id: string;
				protected?: boolean;
			}>;
			assert.equal(listed.find((session) => session.id === create.id)?.protected, true);

			const bulk = (await (await fetch(new URL("api/sessions/archive-inactive", base), { method: "POST" })).json()) as {
				archived: number;
			};
			assert.equal(bulk.archived, 0);

			assert.equal((await protect(false)).status, 200);
			const again = (await (
				await fetch(new URL("api/sessions/archive-inactive", base), { method: "POST" })
			).json()) as { archived: number };
			assert.equal(again.archived, 1);
		} finally {
			await server?.close();
			await hub.shutdown();
		}
	});

	it("serves archive, restore, delete, trash restore and bulk archive", async () => {
		const paths = await fixtureRoot("pixip-archive-");
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
			const selective = (await (
				await fetch(new URL("api/sessions/archive-inactive", base), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ids: [two.id] }),
				})
			).json()) as { archived: number };
			assert.equal(selective.archived, 1);
			assert.equal(((await get("api/sessions")) as unknown[]).length, 1);
			const bulk = (await (await post("api/sessions/archive-inactive")).json()) as { archived: number };
			assert.equal(bulk.archived, 1);
			assert.equal(((await get("api/sessions")) as unknown[]).length, 0);
			assert.equal(((await get("api/archived")) as unknown[]).length, 2);
		} finally {
			await server?.close();
			await hub.shutdown();
		}
	});
});

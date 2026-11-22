import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	cleanupRoots,
	fixtureRoot,
	hubFor,
	infoEntry,
	records,
	sessionFile,
	spawns,
	waitFor,
} from "./helpers/harness.ts";

const PI_ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";

after(async () => {
	await cleanupRoots();
});

describe("session index", () => {
	it("keeps a never-prompted session listed after detach and restart", async () => {
		const paths = await fixtureRoot("pixip-index-");
		const hub = hubFor(paths);
		const cwd = join(paths.dir, "project");
		await mkdir(cwd, { recursive: true });
		const created = await hub.create(cwd, "empty");
		assert.ok(created.logicalId);
		assert.equal(created.name, "empty");

		const written = await records(paths);
		assert.equal(written.length, 1);
		assert.equal(written[0]?.["logicalId"], created.logicalId);
		assert.equal(written[0]?.["piId"], created.id);

		const [spawned] = await spawns(paths);
		assert.equal(spawned?.["pixipSessionId"], created.logicalId);

		await hub.stop(created.id);
		const restarted = hubFor(paths);
		const listed = await restarted.list();
		const row = listed.find((session) => session.logicalId === created.logicalId);
		assert.equal(row?.id, created.id);
		assert.equal(row?.name, "empty");
		assert.equal(row?.cwd, cwd);
		assert.equal(row?.state, "stopped");
		assert.ok((row?.lastActivity ?? 0) > 0);
		await restarted.shutdown();
	});

	it("lists JSONL-only sessions with no logical id", async () => {
		const paths = await fixtureRoot("pixip-index-");
		await sessionFile(paths, [infoEntry("disk name")], { id: PI_ID, cwd: "/tmp/project" });
		const hub = hubFor(paths);
		const listed = await hub.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.id, PI_ID);
		assert.equal(listed[0]?.name, "disk name");
		assert.equal(listed[0]?.logicalId, undefined);
	});

	it("lets the JSONL win for state, name and activity while adding the logical id", async () => {
		const paths = await fixtureRoot("pixip-index-");
		await sessionFile(paths, [infoEntry("disk name")], { id: PI_ID, cwd: "/tmp/project" });
		await writeFile(
			paths.indexPath,
			JSON.stringify([
				{
					logicalId: "logical-1",
					piId: PI_ID,
					piIds: [PI_ID],
					cwd: "/tmp/project",
					name: "spawn name",
					sessionFile: join(paths.sessionsDir, "stale.jsonl"),
					createdAt: "2000-01-01T00:00:00.000Z",
				},
			]),
		);
		const hub = hubFor(paths);
		const listed = await hub.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.name, "disk name");
		assert.equal(listed[0]?.logicalId, "logical-1");
		assert.equal(listed[0]?.lastActivity, Date.parse("2026-11-21T00:00:00.000Z"));
		assert.match(listed[0]?.sessionFile ?? "", /_01a1fb3f-aaaa/);
	});

	it("survives a corrupt index and still lists JSONL sessions", async () => {
		const paths = await fixtureRoot("pixip-index-");
		await sessionFile(paths, [infoEntry("disk name")], { id: PI_ID, cwd: "/tmp/project" });
		await writeFile(paths.indexPath, "{not json");
		const hub = hubFor(paths);
		const listed = await hub.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.id, PI_ID);
	});

	it("merges new spawns into the index without clobbering other records", async () => {
		const paths = await fixtureRoot("pixip-index-");
		const hub = hubFor(paths);
		const first = await hub.create(paths.dir, "one");
		const second = await hub.create(paths.sessionsDir, "two");
		const written = await records(paths);
		assert.equal(written.length, 2);
		assert.deepEqual(
			written.map((record) => record["logicalId"]),
			[first.logicalId, second.logicalId],
		);
		await hub.shutdown();
	});

	it("reattaches an index-only session at its recorded path under a new Pi id", async () => {
		const paths = await fixtureRoot("pixip-index-");
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "empty");
		await hub.stop(created.id);

		const provisional = await hub.provisional(created.id);
		assert.equal(provisional?.info.state, "starting");
		assert.deepEqual(provisional?.entries, []);

		const again = await hub.attach(created.id);
		assert.notEqual(again.id, created.id);
		assert.equal(again.logicalId, created.logicalId);
		assert.equal(again.name, "empty");

		const [record] = await records(paths);
		assert.equal(record?.["piId"], again.id);
		assert.deepEqual(record?.["piIds"], [created.id, again.id]);

		const listed = await hub.list();
		const rows = listed.filter((session) => session.logicalId === created.logicalId);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.id, again.id);

		const all = await spawns(paths);
		assert.equal(all.at(-1)?.["pixipSessionId"], created.logicalId);
		await hub.shutdown();
	});

	it("persists a rename while the session has no JSONL", async () => {
		const paths = await fixtureRoot("pixip-index-");
		const hub = hubFor(paths, {}, { FAKE_PI_RENAME_TO: "renamed" });
		const created = await hub.create(paths.dir, "empty");
		await hub.models(created.id);
		await waitFor(async () => (await records(paths))[0]?.["name"] === "renamed");
		const [record] = await records(paths);
		assert.equal(record?.["piId"], created.id);
		assert.equal(record?.["name"], "renamed");
		await hub.shutdown();
	});
});

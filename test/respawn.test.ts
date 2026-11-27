import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Hub } from "../src/hub.ts";
import {
	HOST_FIXTURE,
	cleanupRoots,
	fixtureRoot,
	hubFor,
	infoEntry,
	sessionFile,
	spawns,
	waitFor,
} from "./helpers/harness.ts";

after(async () => {
	await cleanupRoots();
});

function backendOf(hub: Hub, id: string): string | undefined {
	return (hub as unknown as { live: Map<string, { backend?: string }> }).live.get(id)?.backend;
}

function setOption(hub: Hub, key: string, value: unknown): void {
	(hub as unknown as { options: Record<string, unknown> }).options[key] = value;
}

const spawnCount = async (paths: Awaited<ReturnType<typeof fixtureRoot>>) =>
	(await spawns(paths)).filter((record) => record["type"] === "spawn").length;

describe("respawnSession", () => {
	it("migrates a system-pi session to the current host and keeps its identity", async () => {
		const paths = await fixtureRoot("pixip-respawn-");
		const file = await sessionFile(paths, [infoEntry("Respawn me")]);
		const hub = hubFor(paths, { env: { FAKE_HOST_LOG: paths.logPath } });
		try {
			const before = await hub.attach(file.id);
			assert.equal(before.id, file.id);
			assert.equal(backendOf(hub, file.id), "system");
			const logicalId = before.logicalId;
			const sessionFileBefore = before.sessionFile;

			const frames: Array<Record<string, unknown>> = [];
			const unsubscribe = hub.subscribe(file.id, (frame) => {
				try {
					frames.push(JSON.parse(frame) as Record<string, unknown>);
				} catch {
					// the assertions below only need valid frames
				}
			});

			setOption(hub, "piHostBin", HOST_FIXTURE);
			const after = await hub.respawnSession(file.id);
			assert.equal(after.id, file.id);
			assert.equal(after.logicalId, logicalId);
			assert.equal(after.sessionFile, sessionFileBefore);
			assert.equal(backendOf(hub, file.id), "host");
			assert.equal((await hub.list()).filter((info) => info.id === file.id).length, 1);

			// The subscriber moved to the replacement child.
			await waitFor(() => frames.some((frame) => frame["t"] === "status"));
			assert.ok((await spawnCount(paths)) >= 2);
			unsubscribe();
		} finally {
			await hub.shutdown();
		}
	});

	it("refuses to respawn a busy session without spawning anything", async () => {
		const paths = await fixtureRoot("pixip-respawn-");
		const file = await sessionFile(paths, [infoEntry("Busy")]);
		const hub = hubFor(paths, { env: { FAKE_PI_IS_STREAMING: "1" } });
		try {
			const info = await hub.attach(file.id);
			assert.equal(info.state, "busy");
			const before = await spawnCount(paths);
			await assert.rejects(hub.respawnSession(file.id), /respawn requires idle/);
			assert.equal(await spawnCount(paths), before);
			assert.equal(backendOf(hub, file.id), "system");
		} finally {
			await hub.shutdown();
		}
	});

	it("leaves the old child serving when the replacement cannot start", async () => {
		const paths = await fixtureRoot("pixip-respawn-");
		const file = await sessionFile(paths, [infoEntry("Failed")]);
		const hub = hubFor(paths, { env: { FAKE_HOST_LOG: paths.logPath } });
		try {
			await hub.attach(file.id);
			setOption(hub, "piHostBin", `${paths.dir}/missing-host`);
			await assert.rejects(hub.respawnSession(file.id), /ENOENT|spawn/i);
			assert.equal(backendOf(hub, file.id), "system");

			// The previous system child still answers, so it was not closed early.
			const models = await hub.models(file.id);
			assert.deepEqual(models.models, []);
		} finally {
			await hub.shutdown();
		}
	});
});

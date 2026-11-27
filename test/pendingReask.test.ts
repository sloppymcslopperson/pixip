import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
	addPendingReask,
	parseReaskReply,
	pendingUiKey,
	publicReask,
	readPendingReasks,
	removePendingReask,
	type PendingUiRecord,
} from "../src/pendingReask.ts";
import { cleanupRoots, tempRoot } from "./helpers/harness.ts";

const record: PendingUiRecord = {
	id: "ui-1",
	method: "select",
	sessionId: "pi-1",
	logicalId: "logical-1",
	cwd: "/tmp/project",
	request: { type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick one" },
	raw: '{"type":"extension_ui_request","id":"ui-1","method":"select","title":"Pick one"}',
	timedOutAt: "2026-11-22T00:00:00.000Z",
	timeoutMs: 18_000_000,
	attached: false,
};

after(async () => {
	await cleanupRoots();
});

describe("pending re-ask records", () => {
	it("reads a clear YES or NO and leaves ambiguity undefined", () => {
		assert.equal(parseReaskReply("YES"), true);
		assert.equal(parseReaskReply("No, do not re-ask it."), false);
		assert.equal(parseReaskReply("maybe later"), undefined);
		assert.equal(parseReaskReply("Timeout fired; the prompt says YES or NO"), undefined);
		assert.equal(parseReaskReply("**YES**"), true);
	});

	it("stores, reads and removes records by logical session", async () => {
		const dir = await tempRoot("pixip-reask-");
		const key = pendingUiKey({ id: "pi-1", logicalId: "logical-1" });
		const writes = new Map<string, Promise<void>>();
		await addPendingReask(writes, dir, key, record);
		assert.deepEqual(await readPendingReasks(dir, key), [record]);
		assert.deepEqual(publicReask({ ...record, draft: { answers: { a: 1 } } }).draft, { answers: { a: 1 } });
		await removePendingReask(writes, dir, key, "ui-1");
		assert.deepEqual(await readPendingReasks(dir, key), []);
	});

	it("replaces a record with the same request id instead of duplicating it", async () => {
		const dir = await tempRoot("pixip-reask-");
		const key = pendingUiKey({ id: "pi-1" });
		const writes = new Map<string, Promise<void>>();
		await addPendingReask(writes, dir, key, record);
		await addPendingReask(writes, dir, key, { ...record, timedOutAt: "2026-11-22T01:00:00.000Z" });
		const records = await readPendingReasks(dir, key);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.timedOutAt, "2026-11-22T01:00:00.000Z");
	});
});

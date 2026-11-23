import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	copyQueue,
	createSessionCache,
	readingDistance,
	restoreSession,
	snapshotSession,
} from "../src/client/sessionCache.js";

describe("session cache", () => {
	it("returns a hit and refreshes its recency", () => {
		const cache = createSessionCache(2);
		cache.set("a", { entries: ["a"] });
		cache.set("b", { entries: ["b"] });
		assert.deepEqual(cache.get("a"), { entries: ["a"] });
		cache.set("c", { entries: ["c"] });
		assert.deepEqual(cache.ids(), ["a", "c"]);
		assert.equal(cache.has("b"), false);
	});

	it("evicts the least recently used entry beyond the limit", () => {
		const cache = createSessionCache(3);
		for (const id of ["a", "b", "c"]) cache.set(id, { id });
		cache.set("d", { id: "d" });
		assert.deepEqual(cache.ids(), ["b", "c", "d"]);
		assert.equal(cache.size, 3);
	});

	it("deletes by id and ignores malformed ids", () => {
		const cache = createSessionCache(8);
		cache.set("a", { id: "a" });
		cache.delete("a");
		assert.equal(cache.get("a"), undefined);
		cache.set("", { id: "empty" });
		cache.set(null, { id: "null" });
		assert.equal(cache.size, 0);
	});

	it("clamps a missing or invalid limit to one", () => {
		const cache = createSessionCache(0);
		cache.set("a", { id: "a" });
		cache.set("b", { id: "b" });
		assert.deepEqual(cache.ids(), ["b"]);
	});
});

describe("reading distance", () => {
	it("uses client height when pinned, otherwise the real distance", () => {
		assert.equal(readingDistance(true, 600, 5000, 100), 600);
		assert.equal(readingDistance(false, 600, 5000, 100), 4900);
	});
});

describe("session snapshot and restore", () => {
	it("copies mutable arrays so the cache cannot alias live state", () => {
		const entries = [{ id: "a" }];
		const queue = { steering: ["s"], followUp: ["f"] };
		const snapshot = snapshotSession({ entries, more: 1, distance: 0, stick: false, queue, input: "hi" });
		entries.push({ id: "b" });
		queue.steering.push("later");
		assert.deepEqual(snapshot.entries, [{ id: "a" }]);
		assert.deepEqual(snapshot.queue, { steering: ["s"], followUp: ["f"] });
		assert.equal(snapshot.more, true);
		assert.equal(snapshot.distance, 0);
		assert.equal(snapshot.stick, false);
		assert.equal(snapshot.input, "hi");
	});

	it("normalises malformed cache entries without throwing", () => {
		const restored = restoreSession(undefined);
		assert.deepEqual(restored.entries, []);
		assert.equal(restored.more, false);
		assert.equal(restored.distance, null);
		assert.equal(restored.stick, true);
		assert.equal(restored.info, null);
		assert.deepEqual(restored.queue, { steering: [], followUp: [] });
		assert.equal(restored.input, "");
	});

	it("defaults an explicit false stick and numeric distance", () => {
		const restored = restoreSession({ entries: ["x"], stick: false, distance: 120, input: "draft" });
		assert.deepEqual(restored.entries, ["x"]);
		assert.equal(restored.stick, false);
		assert.equal(restored.distance, 120);
		assert.equal(restored.input, "draft");
	});

	it("copies a queue on restore too", () => {
		const queue = { steering: ["a"], followUp: [] };
		const copied = copyQueue(queue);
		queue.steering.push("b");
		assert.deepEqual(copied, { steering: ["a"], followUp: [] });
	});

	it("keeps the parked control fields and a surface copy", () => {
		const surface = { active: { id: "ask-1" }, queued: [{ id: "ask-2" }], collapsed: true };
		const snapshot = snapshotSession({
			policy: { allow: [], deny: ["rm"], bash: true },
			commands: [{ name: "fit" }],
			lastEntryId: "e9",
			surface,
		});
		surface.queued.push({ id: "ask-3" });
		assert.deepEqual(snapshot.commands, [{ name: "fit" }]);
		assert.equal(snapshot.lastEntryId, "e9");
		assert.deepEqual(snapshot.surface.queued, [{ id: "ask-2" }]);

		const restored = restoreSession(snapshot);
		assert.deepEqual(restored.policy, { allow: [], deny: ["rm"], bash: true });
		assert.deepEqual(restored.commands, [{ name: "fit" }]);
		assert.equal(restored.lastEntryId, "e9");
		assert.equal(restored.surface.active.id, "ask-1");
		assert.equal(restored.surface.collapsed, true);
	});
});

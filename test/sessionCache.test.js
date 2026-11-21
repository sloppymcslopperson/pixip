import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionCache } from "../src/client/sessionCache.js";

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

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FIRST_PAINT_BYTES,
	FILL_CHUNK_BYTES,
	entryWeight,
	lastEntryId,
	mergeTail,
	oldestEntryId,
	planFillChunk,
	planFirstPaint,
	prependWindow,
	unseenEntries,
} from "../src/client/transcriptWindow.js";

describe("transcript budgets", () => {
	it("keeps the agreed first-paint and fill sizes", () => {
		assert.equal(FIRST_PAINT_BYTES, 24 * 1024);
		assert.equal(FILL_CHUNK_BYTES, 32 * 1024);
	});
});

describe("entryWeight", () => {
	it("uses the serialized entry size and falls back for cycles", () => {
		assert.equal(entryWeight({ id: "a" }), JSON.stringify({ id: "a" }).length);
		const cyclic = {};
		cyclic.self = cyclic;
		assert.equal(entryWeight(cyclic), 512);
	});
});

describe("mergeTail", () => {
	it("keeps older windows and lets the incoming copy replace a known id", () => {
		const previous = [
			{ id: "a", n: 1 },
			{ id: "b", n: 1 },
			{ id: "c", n: 1 },
		];
		const incoming = [
			{ id: "c", n: 2 },
			{ id: "d", n: 2 },
		];
		const result = mergeTail(previous, incoming, false);
		assert.deepEqual(
			result.entries.map((entry) => [entry.id, entry.n]),
			[
				["a", 1],
				["b", 1],
				["c", 2],
				["d", 2],
			],
		);
		assert.equal(result.more, false);
	});

	it("starts from the incoming window when it overlaps the first entry", () => {
		const result = mergeTail([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "x" }], true);
		assert.deepEqual(
			result.entries.map((entry) => entry.id),
			["a", "x"],
		);
		assert.equal(result.more, true);
	});

	it("drops duplicate ids inside the merged window", () => {
		const result = mergeTail([], [{ id: "a", n: 1 }, { id: "a", n: 2 }, { id: "b" }], false);
		assert.deepEqual(
			result.entries.map((entry) => entry.id),
			["a", "b"],
		);
	});

	it("tolerates missing lists", () => {
		assert.deepEqual(mergeTail(undefined, null, 1), { entries: [], more: true });
	});
});

describe("window planning", () => {
	it("paints the newest slice within budget, always at least one entry", () => {
		const entries = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, text: "x".repeat(40) }));
		const plan = planFirstPaint(entries, 100);
		assert.ok(plan.start > 0 && plan.start < entries.length);
		assert.ok(plan.bytes >= 100);
		const sliceBytes = entries.slice(plan.start).reduce((sum, entry) => sum + entryWeight(entry), 0);
		assert.equal(plan.bytes, sliceBytes);
		assert.ok(entries.length - plan.start >= 1);

		assert.deepEqual(planFirstPaint([], 100), { start: 0, bytes: 0 });
		assert.deepEqual(planFirstPaint([{ id: "huge", text: "x".repeat(500) }], 10), {
			start: 0,
			bytes: entryWeight({ id: "huge", text: "x".repeat(500) }),
		});
	});

	it("fills upward in bounded chunks, stopping at the oldest entry", () => {
		const entries = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, text: "x".repeat(40) }));
		const plan = planFillChunk(entries, 5, 100);
		assert.ok(plan.from > 0 && plan.from < 5);
		assert.deepEqual(planFillChunk(entries, 0, 100), { from: 0, bytes: 0 });
	});
});

describe("tail and prepend identity", () => {
	it("finds the oldest and newest string ids", () => {
		assert.equal(oldestEntryId([{ id: 1 }, { id: "a" }, { id: "b" }]), "a");
		assert.equal(lastEntryId([{ id: "a" }, { id: "b" }, { id: 1 }]), "b");
		assert.equal(oldestEntryId([]), null);
		assert.equal(lastEntryId(undefined), null);
	});

	it("returns only entries the client does not know yet", () => {
		const fresh = unseenEntries([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }, { noId: true }]);
		assert.deepEqual(
			fresh.map((entry) => entry.id ?? "anonymous"),
			["c", "anonymous"],
		);
	});

	it("prepends an older window without duplicating known entries", () => {
		const result = prependWindow([{ id: "c" }, { id: "d" }], [{ id: "a" }, { id: "b" }, { id: "c" }], true);
		assert.deepEqual(
			result.entries.map((entry) => entry.id),
			["a", "b", "c", "d"],
		);
		assert.equal(result.added, 2);
		assert.equal(result.more, true);
	});

	it("keeps the loaded list when history adds nothing", () => {
		const existing = [{ id: "a" }];
		const result = prependWindow(existing, [{ id: "a" }], false);
		assert.equal(result.entries, existing);
		assert.equal(result.added, 0);
		assert.equal(result.more, false);
	});
});

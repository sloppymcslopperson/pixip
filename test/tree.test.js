import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flattenTree } from "../src/client/tree.js";

const user = (id, parentId, text) => ({
	entry: { type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } },
	children: [],
});
const assistant = (id, parentId, text) => ({
	entry: { type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }] } },
	children: [],
});

function tree() {
	const leaf = user("u2", "a1", "another angle");
	const root = user("u1", null, "first prompt");
	const answer = assistant("a1", "u1", "answer");
	answer.children = [leaf];
	root.children = [answer];
	return { tree: [root], leafId: "u2" };
}

describe("flattenTree", () => {
	it("walks roots depth-first and indents children", () => {
		const { tree: roots, leafId } = tree();
		const rows = flattenTree(roots, leafId);
		assert.deepEqual(rows.map((row) => [row.id, row.depth]), [
			["u1", 0],
			["a1", 1],
			["u2", 2],
		]);
	});

	it("marks the leaf and its ancestor chain as current", () => {
		const { tree: roots, leafId } = tree();
		const rows = flattenTree(roots, leafId);
		assert.deepEqual(rows.map((row) => row.leaf), [false, false, true]);
		assert.deepEqual(rows.map((row) => row.current), [true, true, true]);
		assert.deepEqual(
			flattenTree(roots, "a1").map((row) => row.current),
			[true, true, false],
		);
	});

	it("labels entries and keeps user-only affordances", () => {
		const roots = [
			{
				entry: { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
				label: "good branch",
				children: [{ entry: { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, children: [] }],
			},
			{ entry: { type: "compaction", id: "c1", parentId: "a1", summary: "compacted" }, children: [] },
			{ entry: { type: "message", id: "orphan", parentId: "missing", message: { role: "user", content: [{ type: "text", text: "orphaned" }] } }, children: [] },
		];
		const rows = flattenTree(roots, null);
		assert.equal(rows.length, 4);
		assert.equal(rows[0]?.label, "good branch");
		assert.equal(rows[0]?.text, "hello");
		assert.equal(rows[0]?.user, true);
		assert.equal(rows[1]?.user, false);
		assert.equal(rows[1]?.text, "hi");
		assert.equal(rows[2]?.role, "compaction");
		// An orphaned entry with a broken parent chain still renders as a root.
		assert.deepEqual([rows[3]?.id, rows[3]?.depth, rows[3]?.text], ["orphan", 0, "orphaned"]);
	});

	it("is empty for a missing tree", () => {
		assert.deepEqual(flattenTree(undefined, null), []);
		assert.deepEqual(flattenTree([], null), []);
	});
});

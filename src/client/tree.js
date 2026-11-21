/**
 * `/tree` flattening for the read-only tree sheet, DOM-free so `test/` covers it.
 *
 * RPC `get_tree` returns an array of roots (navigation APIs can create several,
 * and orphaned entries with broken parent chains appear as roots too) with
 * nested `children`. Each node is `{entry, children, label?, labelTimestamp?}`;
 * `leafId` is the current tip. Flattening keeps every root and every child,
 * marks the leaf's ancestor chain as the current branch, and labels user
 * entries so the sheet can offer "fork from here" on them.
 */

/** Text of a message's text blocks, without pulling in the renderer. */
function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ");
}

/**
 * One row per entry, depth-first in tree order. `current` marks every entry on
 * the path from a root to `leafId`; `leaf` marks the tip itself.
 */
export function flattenTree(nodes, leafId) {
	const parents = new Map();
	const collect = (list) => {
		for (const node of Array.isArray(list) ? list : []) {
			const entry = node?.entry;
			if (entry && typeof entry.id === "string") {
				parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
			}
			collect(node?.children);
		}
	};
	collect(nodes);

	const branch = new Set();
	let cursor = typeof leafId === "string" ? leafId : null;
	while (cursor && !branch.has(cursor)) {
		branch.add(cursor);
		cursor = parents.get(cursor) ?? null;
	}

	const rows = [];
	const walk = (list, depth) => {
		for (const node of Array.isArray(list) ? list : []) {
			const entry = node?.entry && typeof node.entry === "object" ? node.entry : {};
			const id = typeof entry.id === "string" ? entry.id : "";
			const role = entry.type === "message" ? (entry.message?.role ?? "message") : (entry.type ?? "entry");
			rows.push({
				id,
				depth,
				role,
				label: typeof node.label === "string" ? node.label : "",
				text: entryText(entry) || (typeof entry.summary === "string" ? entry.summary : ""),
				user: entry.type === "message" && entry.message?.role === "user",
				leaf: id !== "" && id === leafId,
				current: id !== "" && branch.has(id),
			});
			walk(node?.children, depth + 1);
		}
	};
	walk(nodes, 0);
	return rows;
}

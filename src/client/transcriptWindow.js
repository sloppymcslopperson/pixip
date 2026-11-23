// Pure transcript windowing: entry weights, tail merge/dedupe, first-paint
// slice, fill chunks and prepend/resume window merging. No DOM, no state.

export const FIRST_PAINT_BYTES = 24 * 1024;

export const FILL_CHUNK_BYTES = 32 * 1024;

/** Rough DOM cost of an entry, used to keep the first paint small. */
export function entryWeight(entry) {
	try {
		return JSON.stringify(entry).length;
	} catch {
		return 512;
	}
}

/** Newest-first scan of the loaded entries, stopping at the first known id. */
export function mergeTail(previous, incoming, more) {
	const before = Array.isArray(previous) ? previous : [];
	const next = Array.isArray(incoming) ? incoming : [];
	const ids = new Set(next.map((entry) => entry?.id).filter(Boolean));
	const cut = before.findIndex((entry) => entry?.id && ids.has(entry.id));
	const keep = cut > 0 ? cut : 0;
	const merged = [...before.slice(0, keep), ...next];
	const seen = new Set();
	const out = [];
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		const entry = merged[index];
		const id = entry?.id;
		if (typeof id === "string") {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(entry);
	}
	out.reverse();
	return { entries: out, more: Boolean(more) };
}

export function oldestEntryId(entries) {
	return (Array.isArray(entries) ? entries : []).find((entry) => typeof entry?.id === "string")?.id ?? null;
}

export function lastEntryId(entries) {
	const list = Array.isArray(entries) ? entries : [];
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const id = list[index]?.id;
		if (typeof id === "string") return id;
	}
	return null;
}

/**
 * Newest slice painted synchronously. The loop always takes at least one entry
 * when any exist, even if that entry alone exceeds the budget.
 */
export function planFirstPaint(entries, budget = FIRST_PAINT_BYTES) {
	const list = Array.isArray(entries) ? entries : [];
	let start = list.length;
	let bytes = 0;
	while (start > 0 && (bytes === 0 || bytes < budget)) {
		start -= 1;
		bytes += entryWeight(list[start]);
	}
	return { start, bytes };
}

/** One fill chunk above the first paint; always takes at least one entry. */
export function planFillChunk(entries, start, budget = FILL_CHUNK_BYTES) {
	const list = Array.isArray(entries) ? entries : [];
	let from = start;
	let bytes = 0;
	while (from > 0 && bytes < budget) {
		from -= 1;
		bytes += entryWeight(list[from]);
	}
	return { from, bytes };
}

/** Incoming entries this client does not know yet, preserving their order. */
export function unseenEntries(existing, incoming) {
	const known = new Set((Array.isArray(existing) ? existing : []).map((entry) => entry?.id).filter(Boolean));
	return (Array.isArray(incoming) ? incoming : []).filter(
		(entry) => typeof entry?.id !== "string" || !known.has(entry.id),
	);
}

/** Older history window prepended to the loaded entries. */
export function prependWindow(previous, incoming, more) {
	const existing = Array.isArray(previous) ? previous : [];
	const older = unseenEntries(existing, incoming);
	return {
		entries: older.length > 0 ? [...older, ...existing] : existing,
		more: Boolean(more),
		added: older.length,
	};
}

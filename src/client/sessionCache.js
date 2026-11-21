// Bounded in-page cache for recently viewed sessions. Keeping the last window
// plus the reading distance lets a route change repaint before the socket
// snapshot arrives. Pure so node --test can cover the eviction rules.

export function createSessionCache(limit = 8) {
	const max = Math.max(1, Math.floor(Number(limit) || 1));
	const items = new Map();
	return {
		get(id) {
			if (typeof id !== "string" || !items.has(id)) return undefined;
			const value = items.get(id);
			// A hit refreshes recency without changing the stored payload.
			items.delete(id);
			items.set(id, value);
			return value;
		},
		set(id, value) {
			if (typeof id !== "string" || id.length === 0) return;
			items.delete(id);
			items.set(id, value);
			while (items.size > max) items.delete(items.keys().next().value);
		},
		delete(id) {
			items.delete(id);
		},
		has(id) {
			return items.has(id);
		},
		get size() {
			return items.size;
		},
		ids() {
			return [...items.keys()];
		},
	};
}

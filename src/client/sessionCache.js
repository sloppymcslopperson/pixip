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

/** Distance from the bottom used to restore the reading position. */
export function readingDistance(stick, clientHeight, scrollHeight, scrollTop) {
	return stick ? clientHeight : scrollHeight - scrollTop;
}

/** Queues are copied so a cached session cannot alias the live chip arrays. */
export function copyQueue(queue) {
	return {
		steering: Array.isArray(queue?.steering) ? [...queue.steering] : [],
		followUp: Array.isArray(queue?.followUp) ? [...queue.followUp] : [],
	};
}

/** A parked surface keeps its request/queue state, not its live DOM. */
export function copySurface(surface) {
	if (!surface) return null;
	return {
		active: surface.active ?? null,
		queued: Array.isArray(surface.queued) ? [...surface.queued] : [],
		collapsed: surface.collapsed === true,
	};
}

/** Normalise the per-session view snapshot before it goes into the cache. */
export function snapshotSession(view) {
	return {
		entries: Array.isArray(view?.entries) ? [...view.entries] : [],
		more: Boolean(view?.more),
		distance: Number.isFinite(view?.distance) ? view.distance : null,
		stick: view?.stick !== false,
		info: view?.info ?? null,
		footer: view?.footer ?? null,
		policy: view?.policy ?? null,
		commands: Array.isArray(view?.commands) ? [...view.commands] : [],
		addon: view?.addon ?? null,
		queue: copyQueue(view?.queue),
		input: typeof view?.input === "string" ? view.input : "",
		lastEntryId: typeof view?.lastEntryId === "string" ? view.lastEntryId : null,
		surface: copySurface(view?.surface),
	};
}

/** Normalise a cache hit for state and the first repaint. */
export function restoreSession(cached) {
	return {
		entries: Array.isArray(cached?.entries) ? [...cached.entries] : [],
		more: Boolean(cached?.more),
		distance: Number.isFinite(cached?.distance) ? cached.distance : null,
		stick: cached?.stick !== false,
		info: cached?.info ?? null,
		footer: cached?.footer ?? null,
		policy: cached?.policy ?? null,
		commands: Array.isArray(cached?.commands) ? [...cached.commands] : [],
		addon: cached?.addon ?? null,
		queue: copyQueue(cached?.queue),
		input: typeof cached?.input === "string" ? cached.input : "",
		lastEntryId: typeof cached?.lastEntryId === "string" ? cached.lastEntryId : null,
		surface: copySurface(cached?.surface),
	};
}

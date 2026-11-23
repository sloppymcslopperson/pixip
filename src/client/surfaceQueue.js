// DOM-free queue for the inline surface: one active blocking request, the rest
// wait behind it. Kept separate so node tests can cover the no-orphan rule.
export function createSurfaceQueue() {
	return { active: null, queued: [] };
}

/** Add a blocking request; only the first becomes active. */
export function enqueueSurface(queue, request) {
	const id = typeof request?.id === "string" ? request.id : "";
	if (!id) return;
	if (queue.active?.id === id) return;
	if (queue.queued.some((entry) => entry.id === id)) return;
	if (!queue.active) queue.active = request;
	else queue.queued.push(request);
}

/** Remove a settled request and promote the next queued one. */
export function settleSurface(queue, id) {
	if (queue.active?.id === id) {
		queue.active = queue.queued.shift() ?? null;
	} else {
		const index = queue.queued.findIndex((entry) => entry.id === id);
		if (index !== -1) queue.queued.splice(index, 1);
	}
	return queue.active;
}

/** Hide the composer for any active blocking request, then restore its state. */
export function nextComposerState(active, hidden, saved) {
	if (active) return { hidden: true, saved: saved === null ? hidden : saved };
	return { hidden: saved === null ? hidden : saved, saved: null };
}

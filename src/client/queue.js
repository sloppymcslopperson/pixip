/**
 * Steering / follow-up queue helpers, DOM-free so `test/` covers them.
 *
 * `queue_update` carries the complete current queue on every change, so the
 * client replaces its state instead of appending. Clearing the queue returns
 * the texts, which are restored into the composer (the TUI Esc behaviour).
 */

/** Normalize one verbatim `queue_update` event into strings. */
export function queueFromEvent(event) {
	const texts = (value) =>
		Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
	return {
		steering: texts(event?.steering),
		followUp: texts(event?.followUp),
	};
}

/** Flattened queued texts, steering first (the order Pi delivers them). */
export function queueTexts(queue) {
	return [...(queue?.steering ?? []), ...(queue?.followUp ?? [])];
}

/** Number of queued messages. */
export function queueCount(queue) {
	return (queue?.steering?.length ?? 0) + (queue?.followUp?.length ?? 0);
}

/**
 * Composer text after a clear: the queued messages joined with newlines,
 * appended to whatever the user had already typed. Never sends on its own.
 */
export function restoreText(queue, current = "") {
	const restored = queueTexts(queue).join("\n");
	if (!restored) return current;
	if (!current.trim()) return restored;
	return `${current.replace(/\s+$/, "")}\n${restored}`;
}

// Pure live-thinking reducer for the client transcript. No DOM: the painter in
// transcriptView.js owns rendering, and node --test imports this module.
export const THINKING_SEPARATOR = "\n\n";

export function createLiveThought(expanded = false) {
	return { text: "", active: true, expanded: expanded === true };
}

/** Fold one Pi `assistantMessageEvent` into the current live thought. */
export function applyThinkingEvent(live, event) {
	const type = typeof event?.type === "string" ? event.type : "";
	if (type !== "thinking_start" && type !== "thinking_delta" && type !== "thinking_end") return live;
	const current = live ?? createLiveThought(false);
	if (type === "thinking_start") {
		const text =
			current.text.length > 0 && !current.text.endsWith(THINKING_SEPARATOR)
				? `${current.text}${THINKING_SEPARATOR}`
				: current.text;
		return { ...current, text, active: true };
	}
	if (type === "thinking_delta") {
		const delta = typeof event.delta === "string" ? event.delta : "";
		return { ...current, text: `${current.text}${delta}`, active: true };
	}
	return { ...current, active: false };
}

/**
 * A hub restore replaces the text but keeps the current tab's open/closed
 * choice, so a socket reconnect does not collapse a box the reader opened.
 */
export function applyLiveThinkingFrame(live, frame) {
	const text = typeof frame?.text === "string" ? frame.text : "";
	return { text, active: frame?.active === true, expanded: live?.expanded === true };
}

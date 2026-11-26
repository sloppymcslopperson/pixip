/**
 * Volatile live-thinking state for one attached session.
 *
 * Pi forwards thinking as `message_update` records with a `thinking_*`
 * `assistantMessageEvent`. The hub keeps only the current assistant message's
 * thinking text so a newly attached or reloaded browser can rebuild the live
 * box without waiting for the next delta. Nothing here is persisted: the record
 * is cleared at message/turn boundaries and lives only as long as the child.
 *
 * The sequence number is monotonic for the life of the session (it deliberately
 * survives per-message resets) so the attach path can tell buffered deltas that
 * are already folded into this snapshot from genuinely newer ones.
 */

export interface LiveThinkingEvent {
	type?: unknown;
	contentIndex?: unknown;
	delta?: unknown;
	content?: unknown;
}

export interface LiveThinkingState {
	blocks: Map<number, string>;
	active: boolean;
	seq: number;
}

export interface LiveThinkingSnapshot {
	text: string;
	active: boolean;
	seq: number;
}

/** Keep the newest text; a runaway stream must not grow the hub forever. */
export const MAX_LIVE_THINKING_CHARS = 256 * 1024;

const BLOCK_SEPARATOR = "\n\n";

export function createLiveThinking(active = true): LiveThinkingState {
	return { blocks: new Map(), active, seq: 0 };
}

/** Start a new assistant message (or turn phase) without resetting the sequence. */
export function resetLiveThinking(state: LiveThinkingState, active: boolean): void {
	state.blocks.clear();
	state.active = active;
}

/**
 * Fold one `assistantMessageEvent` into the buffer. Returns the new sequence for
 * thinking events and `undefined` for anything else, so the caller can stamp the
 * forwarded frame with it.
 */
export function applyLiveThinkingEvent(state: LiveThinkingState, event: LiveThinkingEvent): number | undefined {
	const type = typeof event?.type === "string" ? event.type : "";
	if (type !== "thinking_start" && type !== "thinking_delta" && type !== "thinking_end") return undefined;
	const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
	state.seq += 1;
	if (type === "thinking_start") {
		if (!state.blocks.has(index)) state.blocks.set(index, "");
		state.active = true;
	} else if (type === "thinking_delta") {
		const delta = typeof event.delta === "string" ? event.delta : "";
		state.blocks.set(index, (state.blocks.get(index) ?? "") + delta);
		state.active = true;
	} else {
		if (typeof event.content === "string") state.blocks.set(index, event.content);
		else if (!state.blocks.has(index)) state.blocks.set(index, "");
		state.active = false;
	}
	trimLiveThinking(state);
	return state.seq;
}

function trimLiveThinking(state: LiveThinkingState): void {
	let total = 0;
	for (const text of state.blocks.values()) total += text.length;
	if (total <= MAX_LIVE_THINKING_CHARS) return;
	let excess = total - MAX_LIVE_THINKING_CHARS;
	for (const [index, text] of state.blocks) {
		if (excess <= 0) break;
		if (text.length <= excess) {
			state.blocks.delete(index);
			excess -= text.length;
			continue;
		}
		state.blocks.set(index, text.slice(excess));
		excess = 0;
	}
}

/** Current aggregate text and phase; callers decide whether to send a frame. */
export function readLiveThinking(state: LiveThinkingState): LiveThinkingSnapshot {
	const text = [...state.blocks.values()].filter((block) => block.length > 0).join(BLOCK_SEPARATOR);
	return { text, active: state.active, seq: state.seq };
}

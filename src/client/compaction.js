// Compaction progress and the success metadata that decorates the boundary.
// The event path stays verbatim: this module only reads Pi's compaction fields.
import { compactionStatusText } from "./render.js";
import { refreshComposerState } from "./sendState.js";
import { scheduleScroll } from "./scroll.js";
import { toast } from "./toast.js";
import { hideCompactionIndicator, showCompactionIndicator, updateCompactionIndicator } from "./transcriptView.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let timer = null;

function hasDraft() {
	return typeof ui.input?.value === "string" && ui.input.value.trim().length > 0;
}

function statusText() {
	const active = state.compacting;
	if (!active) return "";
	return compactionStatusText(active.reason, Date.now() - active.startedAt, hasDraft());
}

function tick() {
	if (!state.compacting) return;
	updateCompactionIndicator(statusText());
}

function stopTimer() {
	clearInterval(timer);
	timer = null;
}

export function startCompaction(reason) {
	stopTimer();
	state.compacting = {
		reason: typeof reason === "string" && reason ? reason : "manual",
		startedAt: Date.now(),
	};
	state.compactionResult = null;
	showCompactionIndicator(statusText());
	refreshComposerState();
	timer = setInterval(tick, 1000);
	scheduleScroll();
}

/**
 * Remove the progress row and report success/abort/error. A successful result is
 * carried until the replacement snapshot arrives, so its boundary can show the
 * post-compaction estimate that only the event carries.
 */
export function endCompaction(event) {
	const active = state.compacting;
	const durationMs = active ? Date.now() - active.startedAt : null;
	stopTimer();
	state.compacting = null;
	hideCompactionIndicator();
	refreshComposerState();

	if (event?.aborted) {
		state.compactionResult = null;
		toast("compaction cancelled");
		return false;
	}
	if (event?.errorMessage) {
		state.compactionResult = null;
		toast(`compaction failed: ${event.errorMessage}`);
		return false;
	}
	const result = event?.result;
	if (!result || typeof result !== "object") return false;
	state.compactionResult = {
		durationMs,
		...(typeof result.estimatedTokensAfter === "number" ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
	};
	return true;
}

/** Leaving the session, losing the socket or stopping it drops the live row. */
export function clearCompaction() {
	stopTimer();
	state.compacting = null;
	state.compactionResult = null;
	state.compactionMeta = null;
	hideCompactionIndicator();
	refreshComposerState();
}

// Composer send-state selectors. Split from the composer so other feature
// modules can refresh the send button without importing composer internals.
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export function refreshSendState() {
	ui.send.disabled = !canSend();
}

/** Compaction owns the composer: no send and no attach until it ends. */
export function refreshComposerState() {
	const info = state.info;
	const locked =
		state.restarting ||
		Boolean(state.compacting) ||
		!info ||
		info.state === "stopped" ||
		info.state === "error" ||
		info.state === "starting";
	ui.input.disabled = locked;
	ui.attach.disabled = locked;
	refreshSendState();
}

export function canSend() {
	const info = state.info;
	if (!info) return false;
	if (state.compacting) return false;
	if (state.restarting || info.state === "stopped" || info.state === "error" || info.state === "starting") return false;
	const attachment = state.pendingAttachment;
	if (attachment) {
		if (attachment.kind === "image") return true;
		if (attachment.kind === "file") return !attachment.uploading && Boolean(attachment.path);
		return false;
	}
	return ui.input.value.trim().length > 0;
}

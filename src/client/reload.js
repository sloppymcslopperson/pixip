// `/reload` browser side: nonce, ephemeral notice row and the post-reload
// handoff. The row is local UI only; it is never sent to Pi or written to JSONL.
import { state } from "./kernel/state.js";
import { rememberReloadNotice, takeReloadNotice } from "./reloadModel.js";
import { appendReloadNotice } from "./transcript.js";
import { toast } from "./toast.js";
import { send } from "./transport.js";

function nonce() {
	return document.querySelector('meta[name="pixip-reload-nonce"]')?.getAttribute("content") ?? "";
}

/** The per-daemon capability both `/reload` and `/pixup-restart` send back. */
export function reloadNonce() {
	return nonce();
}

/** Ask the daemon to reload assets and every live child (optionally pausing first). */
export function sendReload(options = {}) {
	if (!state.sessionId) return;
	const value = nonce();
	if (!value) {
		toast("reload is unavailable on this page; refresh it first");
		return;
	}
	send({ t: "reload", nonce: value, ...(options.pause ? { pause: true } : {}) });
}

/** Keep or resume the pause requests left over from a timed-out paused reload. */
export function sendPauseCancel(mode) {
	const value = nonce();
	if (!value) return;
	send({ t: "pause_cancel", nonce: value, mode });
}

/**
 * Ephemeral notice frame. On a successful/partial reload the client paints the
 * row, remembers it for the reconnect that follows the page reload, then reloads
 * to pick up the new code and nonce. A refusal paints the row and stays put.
 */
export function handleNotice(frame, options = {}) {
	const text = typeof frame.text === "string" ? frame.text : "";
	if (!text) return;
	const id = state.sessionId;
	if (id && options.row !== false) {
		appendReloadNotice(text);
		if (frame.reload === true) rememberReloadNotice(sessionStorage, id, text);
	}
	if (frame.reload === true) {
		toast("reloaded — refreshing this page…");
		setTimeout(() => location.reload(), 350);
	}
}

/** After the forced page reload, put the same local row back once. */
export function restoreReloadNotice() {
	const id = state.sessionId;
	if (!id) return;
	const text = takeReloadNotice(sessionStorage, id);
	if (text) appendReloadNotice(text);
}

// Low-level websocket transport. It knows nothing about features: the
// composition root installs the frame and close handlers, and feature modules
// only call send/connect.
import { state } from "./kernel/state.js";

let onFrame = () => {};
let onClose = () => {};

export function configureTransport(handlers) {
	onFrame = typeof handlers?.onFrame === "function" ? handlers.onFrame : () => {};
	onClose = typeof handlers?.onClose === "function" ? handlers.onClose : () => {};
}

export function socketUrl(sessionId, cursor = null) {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	// Reconnect with the durable entry cursor when this page already holds the
	// transcript: the hub then sends only the delta instead of the full window.
	if (sessionId && cursor) params.set("since", cursor);
	const query = params.toString();
	return `${scheme}://${location.host}/ws${query ? `?${query}` : ""}`;
}

export function connect(sessionId, cursor = null) {
	closeSocket();
	const ws = new WebSocket(socketUrl(sessionId, cursor));
	state.ws = ws;
	ws.onopen = () => {
		state.retries = 0;
	};
	ws.onmessage = (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		onFrame(frame);
	};
	ws.onclose = () => {
		if (state.ws !== ws) return;
		// A dropped socket does not kill the child, but this page no longer tracks
		// the card or the one-at-a-time guard; the snapshot restores the transcript.
		state.ws = null;
		state.bashRunning = false;
		state.bash.clear();
		onClose();
	};
}

export function closeSocket() {
	if (state.ws) {
		const ws = state.ws;
		state.ws = null;
		ws.onclose = null;
		ws.close();
	}
}

export function send(frame) {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(frame));
}

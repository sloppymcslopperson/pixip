// Client transport module; shared state lives in kernel/state.js.
import { failPendingSession, handleFrame, lastEntryId, openSession, showList, toast } from "./app.js";
import { state } from "./kernel/state.js";

export function socketUrl(sessionId) {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	// Reconnect with the durable entry cursor when this page already holds the
	// transcript: the hub then sends only the delta instead of the full window.
	const cursor = sessionId && state.sessionId === sessionId ? lastEntryId() : null;
	if (cursor) params.set("since", cursor);
	const query = params.toString();
	return `${scheme}://${location.host}/ws${query ? `?${query}` : ""}`;
}

export function connect(sessionId) {
	closeSocket();
	const ws = new WebSocket(socketUrl(sessionId));
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
		handleFrame(frame);
	};
	ws.onclose = () => {
		if (state.ws !== ws) return;
		state.ws = null;
		// A dropped socket does not kill the child, but this page no longer tracks
		// the card or the one-at-a-time guard; the snapshot restores the transcript.
		state.bashRunning = false;
		state.bash.clear();
		if (state.pendingCreate) {
			failPendingSession("daemon disconnected");
			return;
		}
		if (!state.sessionId) return;
		const delay = Math.min(2000, 200 * 2 ** state.retries++);
		toast(state.restarting ? `pixip restarting — reconnecting… (${delay}ms)` : `reconnecting… (${delay}ms)`);
		setTimeout(() => connect(state.sessionId), delay);
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

export function route() {
	const match = /^#s=(.+)$/.exec(location.hash);
	const id = match ? decodeURIComponent(match[1]) : null;
	if (id) openSession(id);
	else if (location.hash === "#new") {
		// A reload lands here without a create in flight: fall back to the dashboard.
		if (!state.pendingCreate) {
			history.replaceState(null, "", "");
			void showList();
		}
	} else void showList();
}

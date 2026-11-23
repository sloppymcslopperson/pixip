// Low-level websocket transport. It knows nothing about features: the
// composition root installs the frame and close handlers, and feature modules
// only call connect/park/resume/send.
//
// One keyed connection per route: the empty key is the session-less dashboard
// socket, every other key is a session. A session socket can be parked (kept
// open, server muted) so returning reuses the warm socket instead of paying a
// WebSocket handshake.
import { state } from "./kernel/state.js";

const DASHBOARD = "";
const OPEN = 1;
/** Active socket plus two parked session sockets; the oldest parked is evicted. */
export const PARKED_LIMIT = 2;

let onFrame = () => {};
let onClose = () => {};

/** key -> { key, sessionId, ws, parked } */
const connections = new Map();
/** Session keys in park order, oldest first. */
const parked = [];
let activeKey = null;

function keyOf(sessionId) {
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : DASHBOARD;
}

function sessionOf(key) {
	return key === DASHBOARD ? null : key;
}

function setActive(key) {
	activeKey = key;
	state.ws = key === null ? null : (connections.get(key)?.ws ?? null);
}

function removeParked(key) {
	const index = parked.indexOf(key);
	if (index !== -1) parked.splice(index, 1);
}

function sendOn(conn, frame) {
	if (conn.ws.readyState === OPEN) conn.ws.send(JSON.stringify(frame));
}

function closeConnection(conn) {
	if (connections.get(conn.key) !== conn) return;
	connections.delete(conn.key);
	removeParked(conn.key);
	if (activeKey === conn.key) setActive(null);
	// Intentional closes never run the reconnect/backoff path.
	conn.ws.onopen = null;
	conn.ws.onmessage = null;
	conn.ws.onclose = null;
	try {
		conn.ws.close();
	} catch {
		// already closing
	}
}

function evictParked() {
	while (parked.length > PARKED_LIMIT) {
		const key = parked[0];
		if (key === undefined) break;
		const conn = connections.get(key);
		if (!conn) {
			parked.shift();
			continue;
		}
		closeConnection(conn);
	}
}

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

/**
 * Open (or activate) one keyed socket. An existing open socket is reused, so
 * showing the dashboard again never pays a handshake. Use `resume` to wake a
 * parked session socket.
 */
export function connect(sessionId, cursor = null) {
	const key = keyOf(sessionId);
	const existing = connections.get(key);
	if (existing && !existing.parked && existing.ws.readyState !== 3) {
		setActive(key);
		return existing.ws;
	}
	if (existing) closeConnection(existing);

	const ws = new WebSocket(socketUrl(sessionId, cursor));
	const conn = { key, sessionId: sessionOf(key), ws, parked: false };
	connections.set(key, conn);
	setActive(key);
	ws.onopen = () => {
		if (connections.get(key) !== conn) return;
		if (activeKey === key) state.retries = 0;
	};
	ws.onmessage = (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		onFrame(conn.sessionId, frame);
	};
	ws.onclose = () => {
		if (connections.get(key) !== conn) return;
		connections.delete(key);
		removeParked(key);
		// A parked socket that dies is evicted silently; only the active socket
		// owns the reconnect/backoff path.
		if (conn.parked || activeKey !== key) return;
		setActive(null);
		// A dropped socket does not kill the child, but this page no longer tracks
		// the card or the one-at-a-time guard; the snapshot restores the transcript.
		state.bashRunning = false;
		state.bash.clear();
		onClose(conn.sessionId);
	};
	return ws;
}

/** Park a live session socket: send `park`, keep the WebSocket, evict LRU. */
export function park(sessionId) {
	if (!sessionId) return false;
	const key = keyOf(sessionId);
	const conn = connections.get(key);
	if (!conn || conn.parked || conn.ws.readyState !== OPEN) return false;
	sendOn(conn, { t: "park" });
	conn.parked = true;
	removeParked(key);
	parked.push(key);
	if (activeKey === key) setActive(null);
	evictParked();
	return true;
}

/** Wake a parked socket and ask for the delta after `since`. */
export function resume(sessionId, since = null) {
	if (!sessionId) return false;
	const key = keyOf(sessionId);
	const conn = connections.get(key);
	if (!conn || conn.ws.readyState !== OPEN) {
		if (conn) closeConnection(conn);
		return false;
	}
	conn.parked = false;
	removeParked(key);
	setActive(key);
	sendOn(conn, { t: "resume", ...(typeof since === "string" && since ? { since } : {}) });
	return true;
}

/** Follow a re-key on the same socket: `/new` or an index-only reattach. */
export function rekeyConnection(from, to) {
	if (!from || !to || from === to) return;
	const conn = connections.get(from);
	if (!conn) return;
	const target = connections.get(to);
	if (target && target !== conn) closeConnection(target);
	connections.delete(from);
	conn.key = to;
	conn.sessionId = to;
	connections.set(to, conn);
	const index = parked.indexOf(from);
	if (index !== -1) parked[index] = to;
	if (activeKey === from) setActive(to);
}

/** Close one session socket without running the reconnect path. */
export function closeSession(sessionId) {
	if (!sessionId) return;
	const conn = connections.get(keyOf(sessionId));
	if (conn) closeConnection(conn);
}

/** Close the active socket intentionally (route reset, not a transport drop). */
export function closeSocket() {
	if (activeKey === null) return;
	const conn = connections.get(activeKey);
	if (conn) closeConnection(conn);
	else setActive(null);
}

/** Close every keyed socket and reset the manager (daemon restart, tests). */
export function closeAllConnections() {
	for (const conn of [...connections.values()]) closeConnection(conn);
	connections.clear();
	parked.length = 0;
	setActive(null);
}

/** Inspect the keyed manager without touching the sockets (tests). */
export function connectionState() {
	return {
		active: activeKey === null ? null : sessionOf(activeKey),
		connections: [...connections.keys()].map(sessionOf),
		parked: parked.map(sessionOf),
	};
}

export function hasOpenSession(sessionId) {
	const conn = connections.get(keyOf(sessionId));
	return Boolean(conn && conn.ws.readyState === OPEN);
}

/** Commands target the active route only; parked sockets never receive them. */
export function send(frame) {
	if (activeKey === null) return;
	const conn = connections.get(activeKey);
	if (!conn || conn.parked) return;
	sendOn(conn, frame);
}

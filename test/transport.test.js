import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// The client kernel assumes a browser at module load; the transport itself only
// touches `location` when it builds a URL.
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.location = { protocol: "http:", host: "pixip.test" };
const { closeAllConnections, configureTransport, connect, connectionState, park, rekeyConnection, resume, send } =
	await import("../src/client/transport.js");

class FakeSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = FakeSocket.CONNECTING;
		this.sent = [];
		this.onopen = null;
		this.onmessage = null;
		this.onclose = null;
		FakeSocket.instances.push(this);
	}
	send(text) {
		this.sent.push(JSON.parse(text));
	}
	close() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
	open() {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}
	receive(frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	drop() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
}

const previous = { WebSocket: globalThis.WebSocket, location: globalThis.location };

beforeEach(() => {
	FakeSocket.instances = [];
	globalThis.WebSocket = FakeSocket;
	globalThis.location = { protocol: "http:", host: "pixip.test" };
	closeAllConnections();
	configureTransport({});
});

afterEach(() => {
	closeAllConnections();
	globalThis.WebSocket = previous.WebSocket;
	globalThis.location = previous.location;
});

function open(sessionId, cursor = null) {
	const ws = connect(sessionId, cursor);
	ws.open();
	return ws;
}

describe("keyed transport", () => {
	it("keeps the dashboard socket separate from a session socket", () => {
		const session = open("s1");
		const dashboard = open(null);
		const state = connectionState();
		assert.deepEqual(state.connections, ["s1", null]);
		assert.equal(state.active, null);
		assert.equal(session.readyState, FakeSocket.OPEN);

		send({ t: "create", cwd: "/tmp" });
		assert.deepEqual(dashboard.sent, [{ t: "create", cwd: "/tmp" }]);
		assert.deepEqual(session.sent, []);
	});

	it("parks without closing, mutes the active route, and resumes with a cursor", () => {
		const ws = open("s1");
		assert.equal(park("s1"), true);
		assert.deepEqual(ws.sent, [{ t: "park" }]);
		assert.equal(ws.readyState, FakeSocket.OPEN);
		assert.deepEqual(connectionState(), { active: null, connections: ["s1"], parked: ["s1"] });

		send({ t: "prompt", text: "ignored while parked" });
		assert.deepEqual(ws.sent, [{ t: "park" }]);

		assert.equal(resume("s1", "e1"), true);
		assert.deepEqual(ws.sent, [{ t: "park" }, { t: "resume", since: "e1" }]);
		assert.deepEqual(connectionState(), { active: "s1", connections: ["s1"], parked: [] });
		send({ t: "prompt", text: "go" });
		assert.deepEqual(ws.sent.at(-1), { t: "prompt", text: "go" });
	});

	it("evicts the oldest parked socket past the cap but keeps the active one", () => {
		const a = open("a");
		park("a");
		const b = open("b");
		park("b");
		open("c");
		park("c");
		assert.deepEqual(connectionState(), { active: null, connections: ["b", "c"], parked: ["b", "c"] });
		assert.equal(a.readyState, FakeSocket.CLOSED);
		assert.equal(b.readyState, FakeSocket.OPEN);
	});

	it("evicts a parked socket that drops without reconnecting", () => {
		const closes = [];
		configureTransport({ onClose: (id) => closes.push(id) });
		const ws = open("s1");
		park("s1");
		ws.drop();
		assert.deepEqual(closes, []);
		assert.deepEqual(connectionState(), { active: null, connections: [], parked: [] });
	});

	it("only the active socket reports a transport close", () => {
		const closes = [];
		configureTransport({ onClose: (id) => closes.push(id) });
		const ws = open("s1");
		ws.drop();
		assert.deepEqual(closes, ["s1"]);
		assert.deepEqual(connectionState(), { active: null, connections: [], parked: [] });
	});

	it("moves the key and route on a rekey", () => {
		const ws = open("old");
		rekeyConnection("old", "new");
		assert.deepEqual(connectionState(), { active: "new", connections: ["new"], parked: [] });
		send({ t: "copy" });
		assert.deepEqual(ws.sent, [{ t: "copy" }]);
	});

	it("routes frames with the socket's session id, or null for the dashboard", () => {
		const seen = [];
		configureTransport({ onFrame: (id, frame) => seen.push([id, frame.t]) });
		const session = open("s1");
		const dashboard = open(null);
		session.receive({ t: "status" });
		dashboard.receive({ t: "hello" });
		assert.deepEqual(seen, [
			["s1", "status"],
			[null, "hello"],
		]);
	});
});

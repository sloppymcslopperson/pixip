import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LineBuffer } from "../src/rpc.ts";
import { frameEvent, frameHello, frameSnapshot, WIRE_VERSION } from "../src/wire.ts";

describe("LineBuffer", () => {
	it("splits only on LF and strips one CR", () => {
		const buffer = new LineBuffer();
		assert.deepEqual(buffer.push(Buffer.from('{"a":1}\r\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);
	});

	it("keeps partial records across chunks", () => {
		const buffer = new LineBuffer();
		assert.deepEqual(buffer.push(Buffer.from('{"a":')), []);
		assert.deepEqual(buffer.push(Buffer.from('1}\n')), ['{"a":1}']);
	});

	it("does not split on U+2028 or U+2029", () => {
		const buffer = new LineBuffer();
		const payload = JSON.stringify({ text: "a\u2028b\u2029c" });
		assert.deepEqual(buffer.push(Buffer.from(`${payload}\n`)), [payload]);
	});

	it("survives a multi-byte character split across chunks", () => {
		const buffer = new LineBuffer();
		const bytes = Buffer.from('{"t":"ok\u00e9"}\n');
		assert.deepEqual(buffer.push(bytes.subarray(0, bytes.length - 3)), []);
		assert.deepEqual(buffer.push(bytes.subarray(bytes.length - 3)), ['{"t":"ok\u00e9"}']);
	});

	it("keeps an unterminated tail until flush", () => {
		const buffer = new LineBuffer();
		assert.deepEqual(buffer.push(Buffer.from("tail")), []);
		assert.deepEqual(buffer.flush(), ["tail"]);
	});
});

describe("wire frames", () => {
	it("splices raw event JSON without re-encoding", () => {
		const raw = '{"type":"message_end","message":{"content":[{"type":"text","text":"a/b"}]}}';
		assert.equal(frameEvent(raw), `{"t":"event","ev":${raw}}`);
		assert.deepEqual(JSON.parse(frameEvent(raw)).ev, JSON.parse(raw));
	});

	it("round-trips a snapshot", () => {
		const frame = JSON.parse(
			frameSnapshot({ id: "s1", cwd: "/tmp", state: "idle", lastActivity: 1 }, [{ type: "message" }], "leaf"),
		);
		assert.equal(frame.t, "snapshot");
		assert.equal(frame.leafId, "leaf");
		assert.equal(frame.session.id, "s1");
	});

	it("advertises the wire version with the session list", () => {
		const frame = JSON.parse(frameHello([], "/tmp"));
		assert.equal(frame.v, WIRE_VERSION);
		assert.equal(frame.defaultCwd, "/tmp");
	});
});

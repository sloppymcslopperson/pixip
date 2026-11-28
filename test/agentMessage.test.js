import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAgentMessage, resolveAgentSender } from "../src/client/agentMessage.js";
import { renderMessage } from "../src/client/render.js";

function user(text) {
	return { role: "user", content: [{ type: "text", text }] };
}

describe("parseAgentMessage", () => {
	it("strips one marker line and keeps the body", () => {
		assert.deepEqual(parseAgentMessage("[pixip-agent=logical-1]\nhello there"), {
			senderId: "logical-1",
			body: "hello there",
		});
		assert.deepEqual(parseAgentMessage("[pixip-agent=logical-1]\n\nhello"), {
			senderId: "logical-1",
			body: "\nhello",
		});
	});

	it("accepts a marker at end of text as an empty body", () => {
		assert.deepEqual(parseAgentMessage("[pixip-agent=logical-1]"), { senderId: "logical-1", body: "" });
		assert.deepEqual(parseAgentMessage("[pixip-agent=logical-1]\n"), { senderId: "logical-1", body: "" });
		assert.deepEqual(parseAgentMessage("[pixip-agent=logical-1]\r\n"), { senderId: "logical-1", body: "" });
	});

	it("accepts CRLF and normalizes the rest of the body", () => {
		assert.deepEqual(parseAgentMessage("[pixip-agent=a]\r\none\r\ntwo"), {
			senderId: "a",
			body: "one\ntwo",
		});
	});

	it("accepts every id character the reftag grammar accepts", () => {
		const id = "Session_1.test-name";
		assert.deepEqual(parseAgentMessage(`[pixip-agent=${id}]\nbody`), { senderId: id, body: "body" });
	});

	it("rejects malformed markers and ordinary messages", () => {
		for (const value of [
			undefined,
			null,
			42,
			"",
			"plain prose",
			" [pixip-agent=a]\nbody",
			"hello\n[pixip-agent=a]\nbody",
			"[pixip-agent=a] \nbody",
			"[pixip-agent=bad id]\nbody",
			"[pixip-agent=bad/id]\nbody",
			"[pixip-agent=]\nbody",
			"[pixip-agent=a",
			"[pixip-agent=a]\rbody",
		]) {
			assert.equal(parseAgentMessage(value), null, String(value));
		}
	});

	it("only strips the first marker line", () => {
		assert.deepEqual(parseAgentMessage("[pixip-agent=a]\n[pixip-agent=b]\nbody"), {
			senderId: "a",
			body: "[pixip-agent=b]\nbody",
		});
	});
});

describe("resolveAgentSender", () => {
	const sessions = [
		{ id: "pi-1", logicalId: "logical-1", name: "Auth agent", state: "stopped" },
		{ id: "pi-2", logicalId: "logical-2", name: "   ", state: "busy" },
	];

	it("matches logical ids first and prefers the logical route", () => {
		assert.deepEqual(resolveAgentSender("logical-1", sessions), {
			senderId: "logical-1",
			name: "Auth agent",
			routeId: "logical-1",
		});
	});

	it("also matches a current Pi id and still routes by logical id", () => {
		assert.deepEqual(resolveAgentSender("pi-1", sessions), {
			senderId: "pi-1",
			name: "Auth agent",
			routeId: "logical-1",
		});
	});

	it("falls back to the marker id for a missing row or a blank name", () => {
		assert.deepEqual(resolveAgentSender("ghost", sessions), { senderId: "ghost", name: "ghost", routeId: null });
		assert.deepEqual(resolveAgentSender("logical-2", sessions), {
			senderId: "logical-2",
			name: "logical-2",
			routeId: "logical-2",
		});
	});
});

describe("renderMessage agent bubble", () => {
	const sessions = [
		{ id: "pi-1", logicalId: "logical-1", name: "Auth agent", state: "idle" },
		{ id: "pi-2", logicalId: "logical-2", name: "   ", state: "stopped" },
	];

	it("renders a distinct bubble, hides the marker and links the sender", () => {
		const html = renderMessage(user("[pixip-agent=logical-1]\nplease review"), "entry-1", { sessions });
		assert.match(html, /^<section class="block user agent-message">/);
		assert.match(
			html,
			/<div class="who">Agent <button type="button" class="agent-sender" data-sender-id="logical-1" data-route="logical-1">Auth agent<\/button> sent a message<\/div>/,
		);
		assert.match(html, /<div class="text">please review<\/div>/);
		assert.doesNotMatch(html, /pixip-agent/);
	});

	it("resolves a current Pi id and links the stable logical route", () => {
		const html = renderMessage(user("[pixip-agent=pi-1]\nhello"), "entry-1", { sessions });
		assert.match(html, /data-route="logical-1">Auth agent<\/button>/);
	});

	it("shows the plain sender id when the row is gone", () => {
		const html = renderMessage(user("[pixip-agent=ghost]\nhello"), "entry-1", { sessions });
		assert.match(html, /Agent <span class="agent-sender" data-sender-id="ghost">ghost<\/span> sent a message/);
		assert.doesNotMatch(html, /data-route=/);
	});

	it("falls back to the id when the row has no name", () => {
		const html = renderMessage(user("[pixip-agent=logical-2]\nhello"), "entry-1", { sessions });
		assert.match(html, /data-route="logical-2">logical-2<\/button>/);
	});

	it("keeps user escaping and reftag placeholders in the body", () => {
		const html = renderMessage(user("[pixip-agent=logical-1]\n<b>see</b> [pixip-ref=history/s/e1]"), "entry-1", {
			sessions,
		});
		assert.match(html, /&lt;b&gt;see&lt;\/b&gt;/);
		assert.match(html, /class="reftag-token"/);
	});

	it("renders the empty-body placeholder shell without inventing text", () => {
		const html = renderMessage(user("[pixip-agent=logical-1]"), "entry-1", { sessions });
		assert.match(html, /<div class="text agent-empty"><\/div>/);
		assert.doesNotMatch(html, /\[image\]/);
		assert.doesNotMatch(html, /pixip-agent/);
	});

	it("leaves ordinary user messages unchanged", () => {
		const html = renderMessage(user("hello"), "entry-1", { sessions });
		assert.match(html, /^<section class="block user">/);
		assert.match(html, /<div class="who">you<\/div>/);
		assert.doesNotMatch(html, /agent-message/);
	});
});

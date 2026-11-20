import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ansiToHtml, escapeHtml, summarizeArgs, textOf, toolBlock } from "../src/client/render.js";

describe("ansi", () => {
	it("maps SGR colors to spans and leaves text alone", () => {
		assert.equal(
			ansiToHtml("\u001b[31mred\u001b[0m plain"),
			'<span style="color:#f7768e">red</span> plain',
		);
	});

	it("keeps nested attributes on one span", () => {
		assert.equal(ansiToHtml("\u001b[1;32mgreen\u001b[0m"), '<span style="color:#9ece6a;font-weight:700">green</span>');
	});

	it("drops OSC titles and non-SGR CSI", () => {
		assert.equal(ansiToHtml("\u001b]0;window\u0007text\u001b[2K ok"), "text ok");
	});

	it("collapses carriage-return progress to its final segment", () => {
		assert.equal(ansiToHtml("10%\r55%\r100%\n"), "100%\n");
	});

	it("does not treat U+2028 as a line boundary", () => {
		assert.equal(ansiToHtml("a\u2028b"), "a\u2028b");
	});

	it("escapes html in tool output", () => {
		assert.equal(ansiToHtml("<script>&"), "&lt;script&gt;&amp;");
	});
});

describe("rendering", () => {
	it("summarizes a tool call to one line", () => {
		assert.equal(summarizeArgs("bash", { command: "ls   -la\n  /tmp" }), "ls -la /tmp");
		assert.equal(summarizeArgs("read", { path: "/a/b" }), "/a/b");
		assert.equal(summarizeArgs("x", {}), "");
	});

	it("joins text content blocks", () => {
		assert.equal(textOf([{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }]), "ab");
	});

	it("marks error tool blocks without losing the call id", () => {
		const html = toolBlock("bash", "false", "boom", " error", 12, "call_1");
		assert.match(html, /class="tool error"/);
		assert.match(html, /data-call="call_1"/);
		assert.match(html, /12ms/);
	});

	it("escapes tool names and summaries", () => {
		assert.equal(escapeHtml('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;");
	});
});

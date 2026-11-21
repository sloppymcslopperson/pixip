import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markdownToHtml } from "../src/client/markdown.js";
import { ansiToHtml, bashCardHtml, escapeHtml, renderAssistantBody, renderMessage, summarizeArgs, textOf, toolBlock } from "../src/client/render.js";

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

	it("renders a bash card with the excluded badge and terminal state", () => {
		const html = bashCardHtml({
			command: "cat secret",
			output: "a\nb",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
		});
		assert.match(html, /class="block bash excluded"/);
		assert.match(html, /class="badge excluded">excluded</);
		assert.match(html, /<span class="bash-cmd">cat secret<\/span>/);
		assert.match(html, /<pre class="bash-out">a\nb<\/pre>/);
		assert.match(html, /exit 0/);
	});

	it("keeps the bash card for running, empty, failed and truncated output", () => {
		const running = bashCardHtml({ command: "npm test", output: "", running: true });
		assert.match(running, /class="block bash running empty"/);
		assert.match(running, /running…/);
		const failed = bashCardHtml({ command: "false", output: "", exitCode: 1 });
		assert.match(failed, /class="block bash error empty"/);
		assert.match(failed, /exit 1/);
		const truncated = bashCardHtml({ command: "yes", output: "x", exitCode: 0, truncated: true, fullOutputPath: "/tmp/full.log" });
		assert.match(truncated, /truncated/);
		assert.match(truncated, /\/tmp\/full\.log/);
	});
});

describe("markdown", () => {
	it("renders gfm blocks and inline markup", () => {
		const html = markdownToHtml(
			"# Title\n\n**bold** and *it* and `code`\n\n- one\n- two\n\n> quoted\n\n[link](https://example.com)a\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n",
		);
		assert.match(html, /<h1>Title<\/h1>/);
		assert.match(html, /<strong>bold<\/strong>/);
		assert.match(html, /<em>it<\/em>/);
		assert.match(html, /<code>code<\/code>/);
		assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
		assert.match(html, /<blockquote>[\s\S]*quoted/);
		assert.match(html, /<table>[\s\S]*<td>1<\/td>/);
		assert.match(html, /<pre><code class="language-js">const x = 1;\n<\/code><\/pre>/);
	});

	it("wraps tables in a scroll container", () => {
		const html = markdownToHtml("| a |\n|---|\n| 1 |\n");
		assert.match(html, /^<div class="md-table"><table>/);
		assert.match(html, /<\/table>\s*<\/div>$/);
	});

	it("opens links in a new tab", () => {
		const html = markdownToHtml("[docs](https://example.com/a?b=1&c=2)");
		assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
	});

	it("keeps in-page anchors and drops unsafe schemes", () => {
		assert.match(markdownToHtml("[top](#top)"), /<a href="#top"/);
		const unsafe = markdownToHtml("[click](javascript:alert(1))");
		assert.equal(unsafe.includes("javascript:"), false);
		assert.match(unsafe, /click/);
	});

	it("escapes raw html instead of executing it", () => {
		const html = markdownToHtml("<div onclick=\"x()\">hi</div>\n\n<script>alert(1)</script>");
		assert.equal(html.includes("<div"), false);
		assert.equal(html.includes("<script"), false);
		assert.match(html, /&lt;div onclick=&quot;x\(\)&quot;&gt;hi&lt;\/div&gt;/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	it("escapes markup inside fenced code and keeps it verbatim", () => {
		const html = markdownToHtml("```\n<b>a</b>\n  indented\n```");
		assert.match(html, /&lt;b&gt;a&lt;\/b&gt;\n  indented/);
	});

	it("renders nothing for empty input", () => {
		assert.equal(markdownToHtml(""), "");
		assert.equal(markdownToHtml("   \n"), "");
		assert.equal(markdownToHtml(undefined), "");
	});

	it("leaves user messages literal and renders assistant ones", () => {
		const user = renderMessage({ role: "user", content: [{ type: "text", text: "**not bold** <b>" }] });
		assert.match(user, /\*\*not bold\*\* &lt;b&gt;/);
		assert.equal(user.includes("<strong>"), false);
		const assistant = renderMessage({ role: "assistant", content: [{ type: "text", text: "**bold**" }] });
		assert.match(assistant, /<strong>bold<\/strong>/);
	});

	it("keeps thinking blocks as escaped ansi text", () => {
		const html = renderAssistantBody([{ type: "thinking", thinking: "**raw** <i>" }], false);
		assert.match(html, /<details class="think">/);
		assert.match(html, /\*\*raw\*\* &lt;i&gt;/);
		assert.equal(html.includes("<strong>"), false);
	});
});

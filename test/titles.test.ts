import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fallbackTitle, isSlashPrompt, messageText, normalizeTitle, titlePrompt } from "../src/titles.ts";

describe("session titles", () => {
	it("normalizes model output to sentence case, 3-5 words and 40 chars", () => {
		assert.equal(normalizeTitle('  "Refactor Auth Module"  '), "Refactor auth module");
		assert.equal(normalizeTitle("Title: Fix the broken login"), "Fix the broken login");
		assert.equal(normalizeTitle("one two three four five six seven"), "One two three four five");
		assert.equal(normalizeTitle("x".repeat(80)), `X${"x".repeat(39)}`);
		assert.equal(normalizeTitle(""), "");
	});

	it("falls back to the first meaningful words without markdown", () => {
		assert.equal(fallbackTitle("Please fix the broken login redirect."), "Please fix the broken login");
		assert.equal(fallbackTitle("```ts\nconst x = 1;\n```\nAdd a health check"), "Add a health check");
		assert.equal(fallbackTitle("[Fix the docs](https://example.test) now"), "Fix the docs now");
		assert.equal(fallbackTitle("hi"), "Hi");
	});

	it("builds a bounded one-shot prompt", () => {
		const prompt = titlePrompt("a".repeat(10_000));
		assert.match(prompt, /3 to 5 words/);
		assert.match(prompt, /at most 40 characters/);
		assert.ok(prompt.length < 5_000);
	});

	it("recognises slash commands and reads message text parts", () => {
		assert.equal(isSlashPrompt("/fit work"), true);
		assert.equal(isSlashPrompt("  /skill:review the diff"), true);
		assert.equal(isSlashPrompt("fix the login redirect"), false);
		assert.equal(isSlashPrompt(""), false);

		assert.equal(messageText({ content: "plain text" }), "plain text");
		assert.equal(
			messageText({
				content: [
					{ type: "text", text: "expanded prompt" },
					{ type: "image", data: "ignored" },
					{ type: "text", text: "with instructions" },
				],
			}),
			"expanded prompt\nwith instructions",
		);
		assert.equal(messageText({ content: [] }), "");
		assert.equal(messageText(null), "");
	});
});

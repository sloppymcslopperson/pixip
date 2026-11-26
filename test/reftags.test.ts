import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coverageKeys } from "../src/jsonl.ts";
import { clipText, firstWords, purposeLabel, removeRefTag } from "../src/client/reftagText.js";
import { formatRefTag, messageKey, parseRefTag, refForEntry, scanRefTags } from "../src/reftags.ts";

describe("formatRefTag / parseRefTag", () => {
	const refs = [
		{ kind: "history" as const, session: "logical-1", entry: "e1" },
		{ kind: "history" as const, session: "logical-1", message: { role: "assistant", timestamp: 1735689600000 } },
		{ kind: "inbox" as const, id: "6f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8" },
	];

	it("round-trips all three kinds", () => {
		for (const ref of refs) {
			const tag = formatRefTag(ref);
			assert.ok(tag, `no tag for ${JSON.stringify(ref)}`);
			assert.deepEqual(parseRefTag(tag), ref);
		}
	});

	it("uses the agreed spelling and byte-identical tags", () => {
		assert.equal(formatRefTag(refs[0]), "[pixip-ref=history/logical-1/e1]");
		assert.equal(formatRefTag(refs[1]), "[pixip-ref=history/logical-1/msg:assistant:1735689600000]");
		assert.equal(formatRefTag(refs[2]), "[pixip-ref=inbox/6f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8]");
	});

	it("accepts surrounding whitespace when parsing one tag", () => {
		assert.deepEqual(parseRefTag("  [pixip-ref=inbox/abc] \n"), { kind: "inbox", id: "abc" });
	});

	it("returns null for malformed or unknown input, never throws", () => {
		for (const value of [
			undefined,
			null,
			42,
			"",
			"plain prose",
			"[ref=history/a/b]",
			"[pixip-ref=history/a]",
			"[pixip-ref=session/a/b]",
			"[pixip-ref=history/a/b/c]",
			"[pixip-ref=history/a/msg:Assistant:1]",
			"[pixip-ref=history/a/msg:assistant:-1]",
			"[pixip-ref=history/a/msg:assistant:1.5]",
			"[pixip-ref=history/a b/c]",
			"[pixip-ref=inbox/a b]",
			"[pixip-ref=history/a/b][pixip-ref=inbox/c]",
		]) {
			assert.equal(parseRefTag(value), null, String(value));
		}
	});

	it("returns null from the formatter for an invalid structure", () => {
		for (const value of [
			null,
			undefined,
			{},
			{ kind: "nope", session: "a", entry: "b" },
			{ kind: "history", entry: "b" },
			{ kind: "history", session: "a b", entry: "b" },
			{ kind: "history", session: "a", entry: "b/c" },
			{ kind: "history", session: "a", message: { role: "Assistant", timestamp: 1 } },
			{ kind: "history", session: "a", message: { role: "assistant", timestamp: -1 } },
			{ kind: "inbox", id: "" },
		]) {
			assert.equal(formatRefTag(value as never), null, JSON.stringify(value));
		}
	});
});

describe("scanRefTags", () => {
	it("finds multiple tags with offsets in order", () => {
		const text = "see [pixip-ref=inbox/one] and [pixip-ref=history/s/e2].";
		const found = scanRefTags(text);
		assert.equal(found.length, 2);
		assert.deepEqual(found[0]!.ref, { kind: "inbox", id: "one" });
		assert.equal(found[0]!.tag, "[pixip-ref=inbox/one]");
		assert.equal(text.slice(found[0]!.start, found[0]!.end), found[0]!.tag);
		assert.deepEqual(found[1]!.ref, { kind: "history", session: "s", entry: "e2" });
		assert.equal(found[1]!.end, found[1]!.start + found[1]!.tag.length);
	});

	it("finds adjacent refs and refs across newlines", () => {
		const found = scanRefTags("[pixip-ref=inbox/a][pixip-ref=inbox/b]\n[pixip-ref=inbox/c]");
		assert.deepEqual(
			found.map((match) => match.ref),
			[
				{ kind: "inbox", id: "a" },
				{ kind: "inbox", id: "b" },
				{ kind: "inbox", id: "c" },
			],
		);
	});

	it("does not swallow malformed fragments or prose", () => {
		const text =
			"keep [pixip-ref=history/a/msg:Bogus:1] and [pixip-ref=history/a/msg:assistant] and [pixip-ref=inbox/a b] and [ref=inbox/c] literal";
		assert.deepEqual(scanRefTags(text), []);
	});

	it("returns no matches for non-strings", () => {
		assert.deepEqual(scanRefTags(undefined), []);
		assert.deepEqual(scanRefTags(null), []);
		assert.deepEqual(scanRefTags(7), []);
	});

	it("does not reuse state between scans", () => {
		const text = "[pixip-ref=inbox/a]";
		assert.equal(scanRefTags(text).length, 1);
		assert.equal(scanRefTags(text).length, 1);
	});
});

describe("messageKey", () => {
	it("agrees with coverageKeys for the same entry", () => {
		const entries = [
			{ type: "message", id: "e1", message: { role: "user", timestamp: 1735689600000 } },
			{ type: "message", id: "e2", message: { role: "assistant", timestamp: 1735689601000 } },
		];
		assert.deepEqual(
			entries.map((entry) => messageKey(entry)),
			coverageKeys(entries),
		);
	});

	it("accepts a bare message and rejects roles outside the grammar", () => {
		assert.equal(messageKey({ role: "user", timestamp: 1 }), "msg:user:1");
		assert.equal(messageKey({ role: "toolResult", timestamp: 1 }), null);
		assert.equal(messageKey({ role: "user", timestamp: "1" }), null);
		assert.equal(messageKey(null), null);
	});
});

describe("refForEntry", () => {
	it("prefers a Pi entry id and falls back to the live message key", () => {
		assert.deepEqual(refForEntry("logical", { id: "entry", message: { role: "user", timestamp: 1 } }), {
			kind: "history",
			session: "logical",
			entry: "entry",
		});
		assert.deepEqual(refForEntry("logical", { message: { role: "assistant", timestamp: 2 } }), {
			kind: "history",
			session: "logical",
			message: { role: "assistant", timestamp: 2 },
		});
		assert.equal(refForEntry("logical", { message: { role: "toolResult", timestamp: 2 } }), null);
		assert.equal(refForEntry("bad id", { id: "entry" }), null);
	});
});

describe("reftag chip text", () => {
	it("takes the first eight words with an ellipsis", () => {
		assert.equal(
			firstWords("one two three four five six seven eight nine"),
			"one two three four five six seven eight…",
		);
		assert.equal(firstWords("  one\n\ttwo  "), "one two");
		assert.equal(firstWords("", 3), "");
	});

	it("clips subjects to the configured character budget", () => {
		assert.equal(clipText("a  b\nc", 20), "a b c");
		assert.equal(clipText("abcdefghij", 5), "abcd…");
	});

	it("removes only the exact token", () => {
		const tag = "[pixip-ref=inbox/a]";
		assert.equal(removeRefTag(`look ${tag} here`, tag), "look  here");
		assert.equal(removeRefTag("keep me", tag), "keep me");
		assert.equal(removeRefTag(`a ${tag} b ${tag}`, tag), `a  b ${tag}`);
	});

	it("labels purposes for chips", () => {
		assert.equal(purposeLabel("attention-needed"), "attention needed");
		assert.equal(purposeLabel("custom"), "custom");
	});
});

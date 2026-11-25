import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_LIVE_THINKING_CHARS,
	applyLiveThinkingEvent,
	createLiveThinking,
	readLiveThinking,
	resetLiveThinking,
} from "../src/liveThinking.ts";

describe("live thinking buffer", () => {
	it("aggregates one block and tracks the thinking phase", () => {
		const state = createLiveThinking();
		applyLiveThinkingEvent(state, { type: "thinking_start", contentIndex: 0 });
		applyLiveThinkingEvent(state, { type: "thinking_delta", contentIndex: 0, delta: "hello " });
		applyLiveThinkingEvent(state, { type: "thinking_delta", contentIndex: 0, delta: "world" });
		assert.deepEqual(readLiveThinking(state), { text: "hello world", active: true, seq: 3 });
		applyLiveThinkingEvent(state, { type: "thinking_end", contentIndex: 0, content: "hello world" });
		assert.deepEqual(readLiveThinking(state), { text: "hello world", active: false, seq: 4 });
	});

	it("joins multiple blocks with a blank line and keeps the sequence monotonic", () => {
		const state = createLiveThinking();
		applyLiveThinkingEvent(state, { type: "thinking_start", contentIndex: 0 });
		applyLiveThinkingEvent(state, { type: "thinking_delta", contentIndex: 0, delta: "first" });
		applyLiveThinkingEvent(state, { type: "thinking_end", contentIndex: 0, content: "first" });
		const beforeReset = readLiveThinking(state).seq;
		resetLiveThinking(state, true);
		assert.equal(readLiveThinking(state).seq, beforeReset);
		applyLiveThinkingEvent(state, { type: "thinking_start", contentIndex: 1 });
		applyLiveThinkingEvent(state, { type: "thinking_delta", contentIndex: 1, delta: "second" });
		assert.equal(readLiveThinking(state).text, "second");
	});

	it("keeps the newest text when the buffer exceeds its cap", () => {
		const state = createLiveThinking();
		applyLiveThinkingEvent(state, { type: "thinking_start", contentIndex: 0 });
		applyLiveThinkingEvent(state, {
			type: "thinking_delta",
			contentIndex: 0,
			delta: `${"a".repeat(MAX_LIVE_THINKING_CHARS)}old`,
		});
		applyLiveThinkingEvent(state, { type: "thinking_start", contentIndex: 1 });
		applyLiveThinkingEvent(state, {
			type: "thinking_delta",
			contentIndex: 1,
			delta: `${"n".repeat(MAX_LIVE_THINKING_CHARS)}newest`,
		});
		const text = readLiveThinking(state).text;
		assert.ok(text.length <= MAX_LIVE_THINKING_CHARS);
		assert.ok(text.endsWith("newest"));
		assert.equal(text.includes("old"), false);
	});

	it("ignores non-thinking events", () => {
		const state = createLiveThinking();
		assert.equal(applyLiveThinkingEvent(state, { type: "text_delta", delta: "x" }), undefined);
		assert.deepEqual(readLiveThinking(state), { text: "", active: true, seq: 0 });
	});
});

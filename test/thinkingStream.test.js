import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	THINKING_SEPARATOR,
	applyLiveThinkingFrame,
	applyThinkingEvent,
	createLiveThought,
} from "../src/client/thinkingStream.js";

describe("client live thought", () => {
	it("accumulates deltas and ends the thinking phase", () => {
		let live = createLiveThought();
		live = applyThinkingEvent(live, { type: "thinking_start" });
		live = applyThinkingEvent(live, { type: "thinking_delta", delta: "a" });
		live = applyThinkingEvent(live, { type: "thinking_delta", delta: "b" });
		assert.deepEqual(live, { text: "ab", active: true, expanded: false });
		live = applyThinkingEvent(live, { type: "thinking_end" });
		assert.equal(live.active, false);
	});

	it("separates a second thinking block without a doubled separator", () => {
		let live = { text: "first", active: false, expanded: false };
		live = applyThinkingEvent(live, { type: "thinking_start" });
		assert.equal(live.text, `first${THINKING_SEPARATOR}`);
		live = applyThinkingEvent(live, { type: "thinking_start" });
		assert.equal(live.text, `first${THINKING_SEPARATOR}`);
	});

	it("restores a reattach frame but keeps the tab's open choice", () => {
		const restored = applyLiveThinkingFrame(
			{ text: "stale", active: true, expanded: true },
			{ text: "from the hub", active: false },
		);
		assert.deepEqual(restored, { text: "from the hub", active: false, expanded: true });
		assert.equal(applyLiveThinkingFrame(null, { text: "", active: true }).expanded, false);
	});
});

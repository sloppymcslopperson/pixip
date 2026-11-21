import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queueCount, queueFromEvent, queueTexts, restoreText } from "../src/client/queue.js";

describe("queueFromEvent", () => {
	it("replaces state from the complete queue and ignores non-strings", () => {
		const queue = queueFromEvent({
			type: "queue_update",
			steering: ["change direction", 3, ""],
			followUp: ["summarize when done"],
		});
		assert.deepEqual(queue, { steering: ["change direction"], followUp: ["summarize when done"] });
	});

	it("is empty for a missing or malformed event", () => {
		assert.deepEqual(queueFromEvent(undefined), { steering: [], followUp: [] });
		assert.deepEqual(queueFromEvent({ steering: "nope" }), { steering: [], followUp: [] });
	});

	it("uses the latest event, not the accumulated one", () => {
		const first = queueFromEvent({ steering: ["one", "two"] });
		const second = queueFromEvent({ steering: ["two"] });
		assert.equal(queueCount(first), 2);
		assert.deepEqual(second.steering, ["two"]);
		assert.equal(queueCount(second), 1);
	});
});

describe("queueTexts", () => {
	it("lists steering before follow-up", () => {
		assert.deepEqual(queueTexts({ steering: ["a", "b"], followUp: ["c"] }), ["a", "b", "c"]);
		assert.deepEqual(queueTexts({}), []);
	});
});

describe("restoreText", () => {
	it("joins the queue with newlines", () => {
		assert.equal(restoreText({ steering: ["one", "two"], followUp: ["three"] }), "one\ntwo\nthree");
	});

	it("keeps text the user already typed, and never appends an empty queue", () => {
		assert.equal(restoreText({ steering: ["queued"] }, "draft"), "draft\nqueued");
		assert.equal(restoreText({ steering: ["queued"] }, "draft\n"), "draft\nqueued");
		assert.equal(restoreText({}, "draft"), "draft");
	});
});

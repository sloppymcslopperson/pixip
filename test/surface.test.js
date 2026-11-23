import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSurfaceQueue, enqueueSurface, nextComposerState, settleSurface } from "../src/client/surfaceQueue.js";

const request = (id) => ({ id, method: "select", title: id, options: ["a", "b"] });

describe("inline surface queue", () => {
	it("mounts the first request and queues later ones without orphaning it", () => {
		const queue = createSurfaceQueue();
		enqueueSurface(queue, request("one"));
		enqueueSurface(queue, request("two"));
		assert.equal(queue.active?.id, "one");
		assert.deepEqual(
			queue.queued.map((entry) => entry.id),
			["two"],
		);
		// A duplicate replay of the active request is ignored.
		enqueueSurface(queue, request("one"));
		enqueueSurface(queue, request("two"));
		assert.deepEqual(
			queue.queued.map((entry) => entry.id),
			["two"],
		);
	});

	it("promotes the queued request when the active one settles", () => {
		const queue = createSurfaceQueue();
		enqueueSurface(queue, request("one"));
		enqueueSurface(queue, request("two"));
		enqueueSurface(queue, request("three"));
		assert.equal(settleSurface(queue, "one")?.id, "two");
		assert.deepEqual(
			queue.queued.map((entry) => entry.id),
			["three"],
		);
		assert.equal(settleSurface(queue, "two")?.id, "three");
		assert.equal(settleSurface(queue, "three"), null);
	});

	it("removing an active request without a queue clears the surface", () => {
		const queue = createSurfaceQueue();
		enqueueSurface(queue, request("one"));
		assert.equal(settleSurface(queue, "one"), null);
	});
});

describe("blocking surface composer", () => {
	it("hides while a request is active and restores the previous state", () => {
		const hidden = nextComposerState({ id: "one" }, false, null);
		assert.deepEqual(hidden, { hidden: true, saved: false });
		assert.deepEqual(nextComposerState(null, true, hidden.saved), { hidden: false, saved: null });
	});

	it("leaves a composer that was already hidden hidden", () => {
		const hidden = nextComposerState({ id: "one" }, true, null);
		assert.deepEqual(hidden, { hidden: true, saved: true });
		assert.deepEqual(nextComposerState(null, true, hidden.saved), { hidden: true, saved: null });
	});
});

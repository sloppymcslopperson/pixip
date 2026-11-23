import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { closePlan, openedPlan, snapshotPlan, statusPlan } from "../src/client/sessionPlan.js";

describe("snapshotPlan", () => {
	it("selects resume/replace/snapshot in that priority order", () => {
		assert.equal(snapshotPlan({ resume: true, replace: true }, {}).render, "resume");
		assert.equal(snapshotPlan({ replace: true }, {}).render, "replace");
		assert.equal(snapshotPlan({}, {}).render, "snapshot");
	});

	it("marks a restart, its interruption and the post-paint notice", () => {
		const plan = snapshotPlan({}, { restarting: true, restartWasBusy: true });
		assert.equal(plan.wasRestarting, true);
		assert.equal(plan.resetLive, true);
		assert.equal(plan.repaint, true);
		assert.equal(plan.interrupted, true);
	});

	it("does not treat an idle restart as interrupted", () => {
		const plan = snapshotPlan({}, { restarting: true, restartWasBusy: false });
		assert.equal(plan.interrupted, false);
		assert.equal(snapshotPlan({}, {}).interrupted, false);
	});
});

describe("openedPlan", () => {
	it("ignores a frame without an id", () => {
		assert.deepEqual(openedPlan({ session: {} }, {}), { act: "ignore" });
	});

	it("opens a pending create and routes the next id", () => {
		assert.deepEqual(openedPlan({ session: { id: "new" } }, { pendingCreate: true }), { act: "open", id: "new" });
		assert.deepEqual(openedPlan({ session: { id: "next" } }, { pendingCreate: false }), {
			act: "route",
			id: "next",
		});
	});

	it("reattaches on the live socket and re-keys only when the id changed", () => {
		assert.deepEqual(openedPlan({ session: { id: "b" } }, { sessionId: "a", connected: true }), {
			act: "reattach",
			id: "b",
			previousId: "a",
			changed: true,
			rekey: false,
		});
		assert.deepEqual(
			openedPlan({ session: { id: "b" }, rekey: true }, { sessionId: "a", connected: true }).rekey,
			true,
		);
		assert.deepEqual(openedPlan({ session: { id: "a" }, rekey: true }, { sessionId: "a", connected: true }), {
			act: "reattach",
			id: "a",
			previousId: "a",
			changed: false,
			rekey: false,
		});
	});
});

describe("statusPlan", () => {
	it("applies only to the routed session or the dashboard", () => {
		assert.deepEqual(statusPlan({ session: { id: "b" } }, { sessionId: "a" }), { act: "ignore" });
		assert.deepEqual(statusPlan({ session: { id: "a" } }, { sessionId: "a" }), { act: "apply", quit: false });
		assert.deepEqual(statusPlan({ session: { id: "b" } }, { sessionId: null }), { act: "apply", quit: false });
	});

	it("ends a soft quit when the routed session stops", () => {
		assert.deepEqual(statusPlan({ session: { id: "a", state: "stopped" } }, { sessionId: "a", quitting: true }), {
			act: "apply",
			quit: true,
		});
		assert.equal(statusPlan({ session: { id: "a", state: "idle" } }, { sessionId: "a", quitting: true }).quit, false);
	});
});

describe("closePlan", () => {
	it("fails a pending create and ignores the dashboard", () => {
		assert.deepEqual(closePlan({ pendingCreate: true }), { act: "fail" });
		assert.deepEqual(closePlan({ sessionId: null }), { act: "none" });
	});

	it("backs off exponentially up to two seconds", () => {
		assert.deepEqual(closePlan({ sessionId: "a", retries: 0 }), { act: "reconnect", delay: 200 });
		assert.deepEqual(closePlan({ sessionId: "a", retries: 2 }), { act: "reconnect", delay: 800 });
		assert.deepEqual(closePlan({ sessionId: "a", retries: 10 }), { act: "reconnect", delay: 2000 });
		assert.deepEqual(closePlan({ sessionId: "a", retries: -1 }), { act: "reconnect", delay: 200 });
	});
});

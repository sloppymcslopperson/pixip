import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	claimPauseResult,
	pauseConfirmAction,
	pauseResultKey,
	pauseResultText,
	pauseTargetsText,
	pauseTimeoutActions,
} from "../src/client/pauseModel.js";

class FakeStorage {
	constructor() {
		this.map = new Map();
	}
	getItem(key) {
		return this.map.get(key) ?? null;
	}
	setItem(key, value) {
		this.map.set(key, String(value));
	}
}

describe("pause/resume card model", () => {
	it("labels the restart force action and the reload opt-in differently", () => {
		assert.equal(pauseConfirmAction("restart"), "Force restart");
		assert.equal(pauseConfirmAction("reload"), "Pause & reload");
		assert.deepEqual(
			pauseTimeoutActions("restart").map((action) => action.label),
			["Force restart anyway"],
		);
		assert.deepEqual(
			pauseTimeoutActions("reload").map((action) => action.id),
			["wait", "cancel-keep", "cancel-remove"],
		);
	});

	it("names the pause targets and their reasons", () => {
		assert.equal(
			pauseTargetsText([
				{ id: "a", name: "One", reason: "busy" },
				{ id: "b", reason: "pending UI request" },
			]),
			"One (busy), b (pending UI request)",
		);
		assert.equal(pauseTargetsText(null), "");
	});

	it("renders one ephemeral row for resumed and skipped sessions", () => {
		assert.equal(
			pauseResultText({
				resumed: ["One"],
				skipped: [{ id: "logical-two", name: "Two", reason: "busy" }],
			}),
			"pause/resume: resumed One; skipped Two (busy)",
		);
		assert.equal(pauseResultText({ resumed: [], skipped: [] }), null);
	});

	it("claims one report per daemon so a reconnect cannot paint it twice", () => {
		const storage = new FakeStorage();
		const key = pauseResultKey(42, "2026-11-21T00:00:00.000Z");
		assert.equal(claimPauseResult(storage, key), true);
		assert.equal(claimPauseResult(storage, key), false);
		assert.equal(
			claimPauseResult(
				{
					getItem: () => {
						throw new Error("blocked");
					},
				},
				key,
			),
			false,
		);
	});
});

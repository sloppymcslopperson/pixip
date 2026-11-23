import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	STICK_DISTANCE,
	distanceFromBottom,
	jumpHidden,
	readingDistance,
	restoreScrollTop,
	shouldStick,
} from "../src/client/transcriptScroll.js";

describe("transcript scroll math", () => {
	it("measures the distance from the newest content", () => {
		assert.equal(distanceFromBottom(600, 5000, 100), 4300);
		assert.equal(STICK_DISTANCE, 80);
	});

	it("follows live output only inside the stick threshold", () => {
		assert.equal(shouldStick(0), true);
		assert.equal(shouldStick(79), true);
		assert.equal(shouldStick(80), false);
	});

	it("keeps the client height when pinned and the offset otherwise", () => {
		assert.equal(readingDistance(true, 600, 5000, 100), 600);
		assert.equal(readingDistance(false, 600, 5000, 100), 4900);
	});

	it("restores the saved distance and clamps to the top", () => {
		assert.equal(restoreScrollTop(600, 5000), 4400);
		assert.equal(restoreScrollTop(9999, 5000), 0);
	});

	it("hides the jump control when pinned or outside a session", () => {
		assert.equal(jumpHidden(true, false), true);
		assert.equal(jumpHidden(false, true), true);
		assert.equal(jumpHidden(false, false), false);
	});
});

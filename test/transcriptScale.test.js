import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_PERCENT,
	STEPS,
	clampPercent,
	decreaseLabel,
	increaseLabel,
	nextPercent,
	parseStored,
	previousPercent,
	scaleFactor,
} from "../src/client/transcriptScale.js";

describe("transcript size steps", () => {
	it("uses seven ascending steps with 100 % as the default", () => {
		assert.deepEqual([...STEPS], [50, 65, 80, 100, 115, 130, 150]);
		assert.equal(DEFAULT_PERCENT, 100);
		assert.ok(STEPS.includes(DEFAULT_PERCENT));
		assert.ok(Object.isFrozen(STEPS));
	});

	it("clamps any value to the nearest step", () => {
		assert.equal(clampPercent(100), 100);
		assert.equal(clampPercent(70), 65);
		assert.equal(clampPercent(120), 115);
		assert.equal(clampPercent(1), 50);
		assert.equal(clampPercent(999), 150);
		assert.equal(clampPercent(-40), 50);
		assert.equal(clampPercent(Number.NaN), 100);
		assert.equal(clampPercent("80"), 80);
	});

	it("steps up and down and stops at both ends", () => {
		assert.equal(nextPercent(50), 65);
		assert.equal(nextPercent(100), 115);
		assert.equal(nextPercent(150), 150);
		assert.equal(previousPercent(150), 130);
		assert.equal(previousPercent(100), 80);
		assert.equal(previousPercent(50), 50);
	});

	it("maps percent to the CSS multiplier", () => {
		assert.equal(scaleFactor(100), 1);
		assert.equal(scaleFactor(50), 0.5);
		assert.equal(scaleFactor(150), 1.5);
		assert.equal(scaleFactor(37), 0.5);
	});

	it("labels both buttons with the current percentage", () => {
		assert.equal(decreaseLabel(100), "Decrease transcript text size (100%)");
		assert.equal(increaseLabel(65), "Increase transcript text size (65%)");
		// Labels clamp too, so a stale value never leaks into the aria text.
		assert.equal(increaseLabel(999), "Increase transcript text size (150%)");
	});
});

describe("transcript size storage", () => {
	it("falls back to 100 % for missing or malformed values", () => {
		assert.equal(parseStored(null), 100);
		assert.equal(parseStored(undefined), 100);
		assert.equal(parseStored(""), 100);
		assert.equal(parseStored("   "), 100);
		assert.equal(parseStored("garbage"), 100);
		assert.equal(parseStored("{}"), 100);
	});

	it("keeps valid steps and clamps out-of-range values", () => {
		assert.equal(parseStored("50"), 50);
		assert.equal(parseStored("150"), 150);
		assert.equal(parseStored("115"), 115);
		assert.equal(parseStored(80), 80);
		assert.equal(parseStored("20"), 50);
		assert.equal(parseStored("200"), 150);
		// Hand-edited intermediate values snap to a real control position.
		assert.equal(parseStored("120"), 115);
	});
});

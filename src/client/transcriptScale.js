// Transcript text-size preference: pure step and storage helpers so the client
// stays a thin DOM layer and test/ can cover the range without a browser.
//
// The size is device-local (localStorage) and transcript-scoped: only `#log`
// gets a scaled font size, so the composer (16 px, no iOS zoom), header, footer
// and tool-card chrome keep their px sizes and the root font is untouched.

export const STORAGE_KEY = "pixip.transcriptScale";

/** The seven stops, ascending. Percent, not pixels. */
export const STEPS = Object.freeze([50, 65, 80, 100, 115, 130, 150]);

export const DEFAULT_PERCENT = 100;

/** Snap any number to the nearest step, clamped to both ends. */
export function clampPercent(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULT_PERCENT;
	let best = STEPS[0];
	for (const step of STEPS) {
		if (Math.abs(step - number) < Math.abs(best - number)) best = step;
	}
	return best;
}

/**
 * Parse a stored value. Missing, empty and malformed values fall back to 100 %;
 * finite out-of-range values are clamped to the first/last step.
 */
export function parseStored(raw) {
	if (raw === null || raw === undefined) return DEFAULT_PERCENT;
	const text = String(raw).trim();
	if (text === "") return DEFAULT_PERCENT;
	const number = Number(text);
	if (!Number.isFinite(number)) return DEFAULT_PERCENT;
	return clampPercent(number);
}

/** One step down, or the same value at the minimum. */
export function previousPercent(current) {
	const index = STEPS.indexOf(clampPercent(current));
	if (index <= 0) return STEPS[0];
	return STEPS[index - 1];
}

/** One step up, or the same value at the maximum. */
export function nextPercent(current) {
	const index = STEPS.indexOf(clampPercent(current));
	if (index === -1 || index >= STEPS.length - 1) return STEPS[STEPS.length - 1];
	return STEPS[index + 1];
}

/** CSS multiplier for the `--transcript-scale` variable. */
export function scaleFactor(percent) {
	return clampPercent(percent) / 100;
}

export function decreaseLabel(percent) {
	return `Decrease transcript text size (${clampPercent(percent)}%)`;
}

export function increaseLabel(percent) {
	return `Increase transcript text size (${clampPercent(percent)}%)`;
}

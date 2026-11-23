// Native confirm prompts are unreliable on iOS Safari (the archive button did
// nothing when one was suppressed). The dashboard bulk archive must use the
// app-owned sheet so the action is always visible and cancellable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = await readFile(new URL("../src/client/dashboardSettings.js", import.meta.url), "utf8");

function exportedFunction(name) {
	const start = source.indexOf(`export function ${name}`);
	assert.notEqual(start, -1, `${name} is missing`);
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? undefined : next);
}

describe("dashboard bulk archive", () => {
	it("uses the in-app confirmation sheet, not a native confirm", () => {
		const body = exportedFunction("archiveInactive");
		assert.match(body, /confirmSheet\(/);
		assert.doesNotMatch(body, /window\.confirm/);
	});
});

// The pixip client and hub must not depend on a specific questionnaire plugin:
// the A2UI panel transport is generic and the tool lives in its own package.
// This guard fails if a legacy plugin name leaks into shipped code or docs paths
// that would make it look required.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../", import.meta.url).pathname;
const LEGACY = ["pi_questionare", "pi-questions"];
const SOURCE_DIRS = ["src", "pi-host/src"];

async function files(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const found = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await files(path)));
		else found.push(path);
	}
	return found;
}

describe("legacy questionnaire dependency", () => {
	it("shipped code does not mention the old plugin", async () => {
		const leaks = [];
		for (const dir of SOURCE_DIRS) {
			for (const path of await files(join(ROOT, dir))) {
				if (!/\.(ts|js|mjs|css|html)$/.test(path)) continue;
				const text = await readFile(path, "utf8");
				for (const name of LEGACY) {
					if (text.includes(name)) leaks.push(`${path.slice(ROOT.length)}: ${name}`);
				}
			}
		}
		assert.deepEqual(leaks, []);
	});
});

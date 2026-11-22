import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readCommandLayer, resolveSessionPolicy, validateCommandLayer } from "../src/commands.ts";
import { cleanupRoots, tempRoot } from "./helpers/harness.ts";

const noLog = () => {};

after(async () => {
	await cleanupRoots();
});

describe("command config files", () => {
	it("returns undefined when the file does not exist", async () => {
		const dir = await tempRoot("pixip-config-");
		assert.equal(await readCommandLayer(join(dir, "pixip.json"), noLog), undefined);
	});

	it("reports malformed JSON with the file path", async () => {
		const dir = await tempRoot("pixip-config-");
		const path = join(dir, "pixip.json");
		await writeFile(path, "{not json");
		await assert.rejects(readCommandLayer(path, noLog), (error: Error) => {
			assert.match(error.message, /pixip\.json/);
			assert.match(error.message, /invalid JSON/);
			return true;
		});
	});

	it("rejects wrong types with the file path", () => {
		assert.throws(
			() => validateCommandLayer({ commands: { allow: "compact" } }, "/x/pixip.json", noLog),
			/commands\.allow/,
		);
		assert.throws(() => validateCommandLayer({ commands: { deny: [1] } }, "/x/pixip.json", noLog), /commands\.deny/);
		assert.throws(() => validateCommandLayer({ commands: { bash: "no" } }, "/x/pixip.json", noLog), /commands\.bash/);
		assert.throws(() => validateCommandLayer({ commands: [] }, "/x/pixip.json", noLog), /must be an object/);
		assert.throws(() => validateCommandLayer([], "/x/pixip.json", noLog), /expected a JSON object/);
	});

	it("normalizes names and reports unknown keys", () => {
		const logged: string[] = [];
		const layer = validateCommandLayer(
			{ theme: "x", commands: { allow: ["/compact", " compact ", ""], deny: ["fit"], bash: false, nope: 1 } },
			"/x/pixip.json",
			(message) => logged.push(message),
		);
		assert.deepEqual(layer, { allow: ["compact"], deny: ["fit"], bash: false });
		assert.ok(logged.some((line) => line.includes('unknown key "theme"')));
		assert.ok(logged.some((line) => line.includes('unknown key "commands.nope"')));
	});

	it("accepts an empty document as a neutral layer", () => {
		assert.deepEqual(validateCommandLayer({}, "/x/pixip.json", noLog), {});
		const path = "/x/pixip.json";
		const logged: string[] = [];
		validateCommandLayer({ commands: {} }, path, (message) => logged.push(message));
		assert.deepEqual(logged, []);
	});
});

describe("resolveSessionPolicy", () => {
	it("merges data dir, project and CLI restrict-only", async () => {
		const dataDir = await tempRoot("pixip-config-");
		const cwd = join(dataDir, "project");
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(dataDir, "pixip.json"),
			JSON.stringify({ commands: { allow: ["compact", "name", "model"], deny: ["logout"], bash: true } }),
		);
		await writeFile(
			join(cwd, ".pixip.json"),
			JSON.stringify({ commands: { allow: ["name", "model", "tree"], deny: ["tree"], bash: true } }),
		);
		const policy = await resolveSessionPolicy({
			dataDir,
			cwd,
			cli: { allow: ["model", "name"], deny: ["share"], bash: false },
			log: noLog,
		});
		assert.deepEqual(policy.allow, ["name", "model"]);
		assert.deepEqual(policy.deny, ["logout", "tree", "share"]);
		assert.equal(policy.bash, false);
	});

	it("ignores missing files and keeps the CLI layer", async () => {
		const dataDir = await tempRoot("pixip-config-");
		const policy = await resolveSessionPolicy({
			dataDir,
			cwd: join(dataDir, "nowhere"),
			cli: { deny: ["login"] },
			log: noLog,
		});
		assert.deepEqual(policy, { allow: [], deny: ["login"], bash: true });
	});

	it("fails the resolve when a file is malformed (attach shows the path)", async () => {
		const dataDir = await tempRoot("pixip-config-");
		await writeFile(join(dataDir, "pixip.json"), "[1,2,3]");
		await assert.rejects(
			resolveSessionPolicy({ dataDir, cwd: dataDir, log: noLog }),
			/pixip\.json: expected a JSON object/,
		);
	});
});

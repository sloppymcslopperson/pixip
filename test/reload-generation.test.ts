import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GenerationManager } from "../src/reload/manager.ts";
import { resolve } from "../src/reload/register.ts";

describe("generation manager", () => {
	it("imports, applies and commits a generation", async () => {
		const events: string[] = [];
		const manager = new GenerationManager({
			initial: { name: "gen0" },
			load: (generation) => Promise.resolve({ name: `gen${generation}` }),
			apply: (next, previous) => events.push(`${previous.name}->${next.name}`),
			rollback: (previous) => events.push(`rollback:${previous.name}`),
			requiresRestart: () => undefined,
		});
		const prepared = await manager.prepare();
		assert.equal(prepared.generation, 1);
		assert.equal(manager.generation, 0);
		manager.applyPending();
		assert.deepEqual(events, ["gen0->gen1"]);
		assert.equal(manager.commit(), 1);
		assert.equal(manager.generation, 1);
		assert.deepEqual(manager.current, { name: "gen1" });
	});

	it("keeps the old generation when the import fails", async () => {
		let attempts = 0;
		let applied = false;
		const manager = new GenerationManager({
			initial: { name: "gen0" },
			load: (generation) => {
				attempts += 1;
				if (generation === 1) throw new Error("broken edit");
				return Promise.resolve({ name: `gen${generation}` });
			},
			apply: () => {
				applied = true;
			},
			rollback: () => {},
		});
		await assert.rejects(manager.prepare(), /broken edit/);
		assert.equal(applied, false);
		assert.equal(manager.generation, 0);
		assert.deepEqual(manager.current, { name: "gen0" });

		// A broken import must not poison the next attempt: the retry uses a fresh
		// generation URL instead of Node's cached rejected import.
		const retry = await manager.prepare();
		assert.equal(retry.generation, 2);
		manager.applyPending();
		assert.equal(manager.commit(), 2);
		assert.equal(attempts, 2);
	});

	it("rolls back when the apply fails and keeps the old generation", async () => {
		const events: string[] = [];
		const manager = new GenerationManager({
			initial: { name: "gen0" },
			load: () => Promise.resolve({ name: "gen1" }),
			apply: () => {
				throw new Error("swap failed");
			},
			rollback: (previous) => events.push(`rollback:${previous.name}`),
		});
		await manager.prepare();
		assert.throws(() => manager.applyPending(), /swap failed/);
		assert.deepEqual(events, ["rollback:gen0"]);
		assert.equal(manager.generation, 0);
	});

	it("reports entry/flag changes separately from a code swap", () => {
		const manager = new GenerationManager({
			initial: { name: "gen0" },
			load: () => Promise.resolve({ name: "gen1" }),
			apply: () => {},
			rollback: () => {},
			requiresRestart: () => "bin/pixip.ts changed",
		});
		assert.equal(manager.requiresRestart(), "bin/pixip.ts changed");
	});
});

describe("generation resolve hook", () => {
	const next = () => Promise.resolve({ url: new URL("../src/hub.ts", import.meta.url).href });

	it("inherits the generation from the parent URL", async () => {
		const result = await resolve("./hub.ts", { parentURL: "file:///project/src/server.ts?gen=4" }, next);
		assert.match(result.url, /\?gen=4$/);
	});

	it("leaves the initial unversioned graph alone", async () => {
		const result = await resolve("./hub.ts", { parentURL: "file:///project/bin/pixip.ts" }, next);
		assert.doesNotMatch(result.url, /gen=/);
	});

	it("does not version files outside the project src tree", async () => {
		const outside = () => Promise.resolve({ url: new URL("../test/helpers/harness.ts", import.meta.url).href });
		const result = await resolve(
			"../test/helpers/harness.ts",
			{ parentURL: "file:///project/src/server.ts?gen=2" },
			outside,
		);
		assert.doesNotMatch(result.url, /gen=/);
	});
});

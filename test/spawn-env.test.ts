import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { spawnEnv } from "../src/spawnEnv.ts";

describe("spawnEnv", () => {
	it("drops inherited Pi session identity and keeps the rest of the environment", () => {
		const env = spawnEnv(undefined, {
			PATH: "/usr/bin",
			HOME: "/home/someone",
			PI_SESSION_ID: "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c",
			PI_SESSION_FILE: "/sessions/caller.jsonl",
			PI_MODEL: "some-model",
			ANTHROPIC_API_KEY: "secret",
			HTTPS_PROXY: "http://proxy.invalid:8080",
		});

		assert.equal("PI_SESSION_ID" in env, false);
		assert.equal("PI_SESSION_FILE" in env, false);
		assert.equal(env["PATH"], "/usr/bin");
		assert.equal(env["HOME"], "/home/someone");
		assert.equal(env["PI_MODEL"], "some-model");
		assert.equal(env["ANTHROPIC_API_KEY"], "secret");
		assert.equal(env["HTTPS_PROXY"], "http://proxy.invalid:8080");
	});

	it("lets explicit extras win, including a fresh session identity", () => {
		const env = spawnEnv(
			{
				PIXIP_SESSION_ID: "logical-id",
				PIXIP_INSIDE: "1",
				PI_SESSION_FILE: "/sessions/explicit.jsonl",
			},
			{ PI_SESSION_ID: "caller-id", PI_SESSION_FILE: "/sessions/caller.jsonl" },
		);

		assert.equal(env["PI_SESSION_ID"], undefined);
		assert.equal(env["PI_SESSION_FILE"], "/sessions/explicit.jsonl");
		assert.equal(env["PIXIP_SESSION_ID"], "logical-id");
		assert.equal(env["PIXIP_INSIDE"], "1");
	});
});

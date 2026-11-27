import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { spawnEnv } from "../src/spawnEnv.ts";
import { cleanupRoots, tempRoot } from "./helpers/harness.ts";

after(async () => {
	await cleanupRoots();
});

describe("spawnEnv", () => {
	it("drops inherited Pi session identity and keeps the rest of the environment", async () => {
		const runtime = await tempRoot("pixip-runtime-owned-");
		const env = spawnEnv(undefined, {
			PATH: "/usr/bin",
			HOME: "/home/someone",
			XDG_RUNTIME_DIR: runtime,
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
		assert.equal(env["XDG_RUNTIME_DIR"], runtime);
		assert.equal(env["PI_MODEL"], "some-model");
		assert.equal(env["ANTHROPIC_API_KEY"], "secret");
		assert.equal(env["HTTPS_PROXY"], "http://proxy.invalid:8080");
	});

	it("lets explicit extras win, including a fresh session identity", async () => {
		const runtime = await tempRoot("pixip-runtime-owned-");
		const env = spawnEnv(
			{
				PIXIP_SESSION_ID: "logical-id",
				PIXIP_INSIDE: "1",
				PI_SESSION_FILE: "/sessions/explicit.jsonl",
			},
			{
				XDG_RUNTIME_DIR: runtime,
				PI_SESSION_ID: "caller-id",
				PI_SESSION_FILE: "/sessions/caller.jsonl",
			},
		);

		assert.equal(env["PI_SESSION_ID"], undefined);
		assert.equal(env["PI_SESSION_FILE"], "/sessions/explicit.jsonl");
		assert.equal(env["PIXIP_SESSION_ID"], "logical-id");
		assert.equal(env["PIXIP_INSIDE"], "1");
	});

	it("keeps an owned XDG_RUNTIME_DIR", async () => {
		const home = await tempRoot("pixip-runtime-home-");
		const runtime = await tempRoot("pixip-runtime-owned-");
		const env = spawnEnv({}, { HOME: home, XDG_RUNTIME_DIR: runtime });
		assert.equal(env["XDG_RUNTIME_DIR"], runtime);
	});

	it("falls back to an owned ~/.run without touching the inherited env", async () => {
		const home = await tempRoot("pixip-runtime-home-");
		const base = { HOME: home, XDG_RUNTIME_DIR: join(home, "missing") };
		const env = spawnEnv({}, base);

		assert.equal(env["XDG_RUNTIME_DIR"], join(home, ".run"));
		assert.equal(base.XDG_RUNTIME_DIR, join(home, "missing"));
		assert.equal((await stat(join(home, ".run"))).mode & 0o777, 0o700);
	});

	it("repairs a ~/.run with the wrong mode", async () => {
		const home = await tempRoot("pixip-runtime-home-");
		await mkdir(join(home, ".run"), { mode: 0o755 });
		const env = spawnEnv({}, { HOME: home });

		assert.equal(env["XDG_RUNTIME_DIR"], join(home, ".run"));
		assert.equal((await stat(join(home, ".run"))).mode & 0o777, 0o700);
	});

	it("refuses a ~/.run that is not a directory", async () => {
		const home = await tempRoot("pixip-runtime-home-");
		await writeFile(join(home, ".run"), "not a directory");

		assert.throws(() => spawnEnv({}, { HOME: home }), /exists but is not a directory/);
	});
});

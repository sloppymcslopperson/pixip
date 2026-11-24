import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { PiBackend } from "../src/backend.ts";
import type { RpcChild, RpcChildOptions } from "../src/rpc.ts";
import { FIXTURE, cleanupRoots, fixtureRoot, hubFor } from "./helpers/harness.ts";

after(async () => {
	await cleanupRoots();
});

describe("spawn backend seam", () => {
	it("creates the child through the injected backend with the RPC arguments", async () => {
		const paths = await fixtureRoot("pixip-backend-");
		const calls: RpcChildOptions[] = [];
		const backend: PiBackend = {
			create(options) {
				calls.push(options);
				const child = {
					command(command: { type?: string }) {
						return Promise.resolve(
							command.type === "get_state"
								? { sessionId: "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c", sessionFile: "memory" }
								: {},
						);
					},
					async close() {},
					send() {},
				};
				return child as unknown as RpcChild;
			},
		};

		const hub = hubFor(paths, { backend });
		const created = await hub.create(paths.dir, "backend session");
		assert.equal(created.id, "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, FIXTURE);
		assert.deepEqual(calls[0]?.args.slice(0, 3), ["--mode", "rpc", "--session-dir"]);
		assert.deepEqual(calls[0]?.args.slice(-2), ["--name", "backend session"]);
		await hub.shutdown();
	});

	it("gives the spawned child its own PIXIP session key and no inherited Pi identity", async () => {
		const paths = await fixtureRoot("pixip-backend-");
		const calls: RpcChildOptions[] = [];
		const backend: PiBackend = {
			create(options) {
				calls.push(options);
				const child = {
					command(command: { type?: string }) {
						return Promise.resolve(
							command.type === "get_state"
								? { sessionId: "01a1fb3f-bbbb-7664-b952-f6673a2c7a8c", sessionFile: "memory" }
								: {},
						);
					},
					async close() {},
					send() {},
				};
				return child as unknown as RpcChild;
			},
		};

		const hub = hubFor(paths, { backend });
		const created = await hub.create(paths.dir, "env session");
		const env = calls[0]?.env ?? {};
		assert.equal(env["PIXIP_SESSION_ID"], created.logicalId);
		assert.equal(env["PIXIP_INSIDE"], "1");
		assert.equal("PI_SESSION_ID" in env, false);
		assert.equal("PI_SESSION_FILE" in env, false);
		await hub.shutdown();
	});
});

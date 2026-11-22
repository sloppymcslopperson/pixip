import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import WebSocket from "ws";

import { MAX_IMAGE_BYTES } from "../src/attachments.ts";
import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import {
	cleanupRoots,
	exists,
	fixtureRoot,
	hubFor,
	spawns as records,
	waitFor,
	type TestPaths,
} from "./helpers/harness.ts";

async function boot(paths: TestPaths): Promise<{ hub: Hub; server: RunningServer }> {
	const hub = hubFor(paths);
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	return { hub, server };
}

after(async () => {
	await cleanupRoots();
});

describe("image attachments", () => {
	it("forwards a valid image on prompt and steer", async () => {
		const paths = await fixtureRoot("pixip-attachments-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);
		const image = { type: "image", data: Buffer.from("not really a png").toString("base64"), mimeType: "image/png" };

		const ws = new WebSocket(`${server.url}ws?session=${encodeURIComponent(created.id)}`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.send(JSON.stringify({ t: "prompt", text: "from the socket", images: [image] }));
		await waitFor(async () =>
			(await records(paths)).some((record) => record["type"] === "prompt" && record["text"] === "from the socket"),
		);
		ws.close();

		await hub.prompt(created.id, "look at this", undefined, [image]);
		await hub.steer(created.id, "and this", [image]);

		const prompts = (await records(paths)).filter((record) => record["type"] === "prompt");
		assert.equal(prompts.length, 3);
		assert.deepEqual(prompts[0]?.["images"], [image]);
		assert.equal(prompts[0]?.["streamingBehavior"], null);
		assert.deepEqual(prompts[1]?.["images"], [image]);
		assert.equal(prompts[1]?.["streamingBehavior"], null);
		assert.deepEqual(prompts[2]?.["images"], [image]);
		assert.equal(prompts[2]?.["streamingBehavior"], "steer");

		await server.close();
		await hub.shutdown();
	});

	it("rejects malformed images before any prompt reaches pi", async () => {
		const paths = await fixtureRoot("pixip-attachments-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);

		await assert.rejects(
			hub.prompt(created.id, "bad data", undefined, [{ type: "image", data: "@@@", mimeType: "image/png" }]),
			/base64/,
		);
		await assert.rejects(
			hub.prompt(created.id, "bad type", undefined, [
				{ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/svg+xml" },
			]),
			/unsupported image type/,
		);
		await assert.rejects(
			hub.prompt(created.id, "too many", undefined, [
				{ type: "image", data: Buffer.from("a").toString("base64"), mimeType: "image/png" },
				{ type: "image", data: Buffer.from("b").toString("base64"), mimeType: "image/png" },
			]),
			/only one image/,
		);
		await assert.rejects(
			hub.prompt(created.id, "too large", undefined, [
				{ type: "image", data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"), mimeType: "image/png" },
			]),
			/image is too large/,
		);
		assert.equal((await records(paths)).filter((record) => record["type"] === "prompt").length, 0);

		await server.close();
		await hub.shutdown();
	});
});

describe("file uploads", () => {
	it("writes an HTTP upload under the logical session and returns its path", async () => {
		const paths = await fixtureRoot("pixip-attachments-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const created = await hub.create(paths.dir);

		const response = await fetch(
			new URL(
				`api/sessions/${encodeURIComponent(created.id)}/uploads?name=${encodeURIComponent("notes file.txt")}`,
				server.url,
			),
			{ method: "POST", body: Buffer.from("hello attachment") },
		);
		assert.equal(response.status, 200);
		const body = (await response.json()) as { ok?: boolean; path?: string; name?: string; size?: number };
		assert.equal(body.ok, true);
		assert.equal(body.name, "notes_file.txt");
		assert.equal(body.size, "hello attachment".length);
		assert.ok(body.path?.includes(join("uploads", created.logicalId ?? created.id)));
		assert.equal(await readFile(String(body.path), "utf8"), "hello attachment");

		await server.close();
		await hub.shutdown();
	});

	it("clears uploads on /new and archive but keeps them across stop", async () => {
		const paths = await fixtureRoot("pixip-attachments-", { logName: "commands.jsonl" });
		const { hub, server } = await boot(paths);
		const first = await hub.create(paths.dir);
		const firstUpload = await hub.uploadFile(first.id, "keep-until-new.txt", Buffer.from("one"));
		await hub.stop(first.id);
		assert.equal(await exists(firstUpload.path), true);
		const reattached = await hub.attach(first.id);
		await hub.newSession(reattached.id);
		assert.equal(await exists(firstUpload.path), false);

		const second = await hub.create(paths.dir);
		const secondUpload = await hub.uploadFile(second.id, "archive-me.txt", Buffer.from("two"));
		await hub.archive(second.id);
		assert.equal(await exists(secondUpload.path), false);

		await server.close();
		await hub.shutdown();
	});
});

import assert from "node:assert/strict";
import { utimes, writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";

import { cleanupRoots, fixtureRoot, hubFor, sessionFile } from "./helpers/harness.ts";

const ID = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";

async function fixture(lines: string[], id = ID) {
	const paths = await fixtureRoot("pixip-names-", { flat: true, logName: "spawns.jsonl" });
	const { path } = await sessionFile(paths, lines, { id, cwd: "/tmp/project" });
	const hub = hubFor(paths, { piBin: "true" });
	return { dir: paths.dir, path, hub };
}

const info = (name: string | null, id = "i1") =>
	JSON.stringify({ type: "session_info", id, parentId: null, timestamp: "2026-11-21T00:00:01.000Z", name });
const message = (index: number) =>
	JSON.stringify({
		type: "message",
		id: `m${index}`,
		parentId: null,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: `q${index}` }] },
	});

after(async () => {
	await cleanupRoots();
});

describe("stopped-session names", () => {
	it("leaves header-only sessions unnamed", async () => {
		const { hub } = await fixture([]);
		const [listed] = await hub.list();
		assert.equal(listed?.name, undefined);
	});

	it("reads a name near the top of the file", async () => {
		const { hub } = await fixture([info("early name"), message(0)]);
		const [listed] = await hub.list();
		assert.equal(listed?.name, "early name");
	});

	it("prefers a rename later in a long file", async () => {
		const filler = Array.from({ length: 60 }, (_, index) => message(index));
		const { hub } = await fixture([info("first name"), ...filler, info("renamed later", "i2")]);
		const [listed] = await hub.list();
		assert.equal(listed?.name, "renamed later");
	});

	it("keeps the previous name when a later session_info is empty", async () => {
		const filler = Array.from({ length: 60 }, (_, index) => message(index));
		const { hub } = await fixture([info("kept"), ...filler, info("", "i2"), info(null, "i3")]);
		const [listed] = await hub.list();
		assert.equal(listed?.name, "kept");
	});

	it("still finds the name when the final line is truncated", async () => {
		const { path, hub } = await fixture([info("truncated tail"), message(0)]);
		const content = `${JSON.stringify({ type: "session", version: 3, id: ID, cwd: "/tmp/project", timestamp: "2026-11-21T00:00:00.000Z" })}\n${info("truncated tail")}\n{"type":"message","id":`;
		await writeFile(path, content);
		const [listed] = await hub.list();
		assert.equal(listed?.name, "truncated tail");
	});

	it("invalidates the cached name when the file changes", async () => {
		const { path, hub } = await fixture([info("before")]);
		assert.equal((await hub.list())[0]?.name, "before");
		const next = Date.now() / 1000 + 10;
		await writeFile(`${path}`, "");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: ID, cwd: "/tmp/project", timestamp: "2026-11-21T00:00:00.000Z" })}\n${info("after")}\n`,
		);
		await utimes(path, next, next);
		assert.equal((await hub.list())[0]?.name, "after");
	});
});

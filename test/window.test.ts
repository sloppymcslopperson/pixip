import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, describe, it } from "node:test";

import { ENTRY_TEXT_LIMIT, WINDOW_ENTRIES, parseEntries, truncateEntries } from "../src/hub.ts";
import { cleanupRoots, fixtureRoot, hubFor, sessionFile } from "./helpers/harness.ts";

async function fixture(lines: string[]) {
	const paths = await fixtureRoot("pixip-window-", { flat: true });
	const { id, path } = await sessionFile(paths, lines, { cwd: "/tmp/project" });
	return { dir: paths.dir, path, id, paths };
}

function message(index: number, text = `entry ${index}`): string {
	return JSON.stringify({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

after(async () => {
	await cleanupRoots();
});

describe("jsonl windows", () => {
	it("parses entries oldest first and skips jinxed lines", () => {
		const entries = parseEntries([message(1), "not json", "", message(2), '{"type":'].join("\n"));
		assert.deepEqual(
			entries.map((entry) => (entry as { id: string }).id),
			["m1", "m2"],
		);
	});

	it("drops a partial first line and honours the entry limit", () => {
		const lines = Array.from({ length: 10 }, (_, index) => message(index)).join("\n");
		const text = `alf line\n${lines}`;
		const entries = parseEntries(text, { dropFirst: true, maxEntries: 3 });
		assert.deepEqual(
			entries.map((entry) => (entry as { id: string }).id),
			["m7", "m8", "m9"],
		);
	});

	it("truncates long text and tool output, leaving short entries alone", () => {
		const long = "x".repeat(ENTRY_TEXT_LIMIT + 50);
		const [short, big] = truncateEntries([JSON.parse(message(1, "short")), JSON.parse(message(2, long))]) as Array<{
			truncated?: boolean;
			message: { content: Array<{ text: string }> };
		}>;
		assert.equal(short?.message.content[0]?.text, "short");
		assert.equal(short?.truncated, undefined);
		assert.equal(big?.truncated, true);
		const text = big?.message.content[0]?.text ?? "";
		assert.ok(text.startsWith("x".repeat(ENTRY_TEXT_LIMIT)));
		assert.match(text, /truncated \(50 more characters\)/);
	});

	it("treats an empty or truncated tail as an empty transcript", async () => {
		const { id, path, paths } = await fixture([]);
		const hub = hubFor(paths);
		const snapshot = await hub.provisional(id);
		assert.equal(snapshot?.info.state, "starting");
		assert.deepEqual(snapshot?.entries, []);
		assert.equal(snapshot?.more, false);

		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: "/tmp/project", timestamp: "2026-11-21T00:00:00.000Z" })}\n${message(0)}\n{"type":"mess`,
		);
		const partial = await hub.provisional(id);
		assert.deepEqual(
			partial?.entries.map((entry) => (entry as { id: string }).id),
			["m0"],
		);
	});

	it("returns the last window with more older entries", async () => {
		const lines = Array.from({ length: 800 }, (_, index) => message(index));
		const { id, paths } = await fixture(lines);
		const hub = hubFor(paths);
		const snapshot = await hub.provisional(id);
		assert.equal(snapshot?.entries.length, WINDOW_ENTRIES);
		assert.equal((snapshot?.entries[0] as { id: string }).id, "m600");
		assert.equal(snapshot?.more, true);
		assert.equal((snapshot?.entries.at(-1) as { id: string }).id, "m799");
	});

	it("serves the window before an anchor and reports whether more remain", async () => {
		const lines = Array.from({ length: 800 }, (_, index) => message(index));
		const { id, paths } = await fixture(lines);
		const hub = hubFor(paths);
		const window = await hub.earlier(id, "m600");
		assert.equal(window.entries.length, WINDOW_ENTRIES);
		assert.equal((window.entries[0] as { id: string }).id, "m400");
		assert.equal((window.entries.at(-1) as { id: string }).id, "m599");
		assert.equal(window.more, true);

		const first = await hub.earlier(id, "m400");
		assert.equal((first.entries.at(-1) as { id: string }).id, "m399");
		const start = await hub.earlier(id, "m200");
		assert.equal(start.entries.length, 200);
		assert.equal(start.more, false);
		assert.equal((start.entries[0] as { id: string }).id, "m0");
	});

	it("grows the read until a full window fits behind a huge entry", async () => {
		const huge = "y".repeat(400_000);
		const lines = [message(0, huge), ...Array.from({ length: 300 }, (_, index) => message(index + 1))];
		const { id, paths } = await fixture(lines);
		const hub = hubFor(paths);
		const window = await hub.earlier(id, "m1");
		assert.equal((window.entries.at(-1) as { id: string }).id, "m0");
		assert.equal(window.entries.length, 1);
		assert.equal(window.more, false);

		const tail = await hub.earlier(id, "m101");
		assert.equal(tail.entries.length, 101);
		assert.equal((tail.entries[0] as { id: string }).id, "m0");
		assert.equal(tail.more, false);
	});

	it("returns nothing for an unknown anchor without throwing", async () => {
		const lines = Array.from({ length: 10 }, (_, index) => message(index));
		const { id, paths } = await fixture(lines);
		const hub = hubFor(paths);
		assert.deepEqual(await hub.earlier(id, "nope"), { entries: [], more: false });
	});
});

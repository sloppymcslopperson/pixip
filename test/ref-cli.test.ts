import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { cleanupRoots, fixtureRoot, hubFor, infoEntry, sessionFile } from "./helpers/harness.ts";

const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(args: string[]): Promise<RunResult> {
	const env = { ...process.env };
	delete env["PIXIP_DAEMON_URL"];
	delete env["PIXIP_INSIDE"];
	delete env["PIXIP_SESSION_ID"];
	delete env["PIXIP_DATA_DIR"];
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
			const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code: exit, stdout, stderr });
		});
	});
}

function entry(id: string, role: string, text: string, timestamp: number, parentId: string | null) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role, timestamp, content: [{ type: "text", text }] },
	};
}

after(async () => {
	await cleanupRoots();
});

describe("pixip ref", () => {
	it("resolves history and inbox refs offline, with json and the safe exit codes", async () => {
		const paths = await fixtureRoot("pixip-ref-cli-");
		const hub = hubFor(paths);

		const live = await hub.create(paths.dir, "live session");
		const liveStamp = 1735689600100;
		await sessionFile(
			paths,
			[
				infoEntry("live session"),
				JSON.stringify(entry("e1", "user", "live first", liveStamp, null)),
				JSON.stringify(entry("e2", "assistant", "live answer", liveStamp + 1, "e1")),
				JSON.stringify(entry("e3", "user", "x".repeat(5000), liveStamp + 2, "e2")),
			],
			{ id: live.id, cwd: paths.dir },
		);

		const stopped = await hub.create(paths.dir, "stopped session");
		const stoppedStamp = 1735689600200;
		await sessionFile(
			paths,
			[infoEntry("stopped session"), JSON.stringify(entry("s1", "user", "stopped text", stoppedStamp, null))],
			{ id: stopped.id, cwd: paths.dir },
		);
		await hub.stop(stopped.id);

		const archived = await hub.create(paths.dir, "archived session");
		await sessionFile(
			paths,
			[infoEntry("archived session"), JSON.stringify(entry("a1", "assistant", "archived text", 1735689600300, null))],
			{ id: archived.id, cwd: paths.dir },
		);
		await hub.stop(archived.id);
		await hub.archive(archived.id);

		const sent = await hub.inboxSend({
			subject: "ref inbox subject",
			body: "ref inbox body",
			purpose: "deliverable",
			sessionId: live.logicalId,
		});
		const deleted = await hub.inboxSend({
			subject: "deleted subject",
			body: "deleted body",
			purpose: "no-rush",
			sessionId: live.logicalId,
		});
		await hub.inboxDelete(deleted.id);
		// Prove the command is offline: no daemon, no REST, only the data dir.
		await hub.shutdown();

		const liveTag = `[pixip-ref=history/${live.logicalId}/e2]`;
		const liveRun = await run(["ref", liveTag, "--data-dir", paths.dataDir]);
		assert.equal(liveRun.code, 0, liveRun.stderr);
		assert.match(liveRun.stdout, /kind: history/);
		assert.match(liveRun.stdout, /role: assistant/);
		assert.match(liveRun.stdout, /session: live session/);
		assert.match(liveRun.stdout, /entry: e2/);
		assert.match(liveRun.stdout, /live answer\s*$/);

		const msgRun = await run([
			"ref",
			`[pixip-ref=history/${live.logicalId}/msg:assistant:${liveStamp + 1}]`,
			"--data-dir",
			paths.dataDir,
		]);
		assert.equal(msgRun.code, 0, msgRun.stderr);
		assert.match(msgRun.stdout, /live answer\s*$/);

		const stoppedRun = await run(["ref", `[pixip-ref=history/${stopped.logicalId}/s1]`, "--data-dir", paths.dataDir]);
		assert.equal(stoppedRun.code, 0, stoppedRun.stderr);
		assert.match(stoppedRun.stdout, /stopped text\s*$/);

		const archivedRun = await run(["ref", `[pixip-ref=history/${archived.logicalId}/a1]`, "--data-dir", paths.dataDir]);
		assert.equal(archivedRun.code, 0, archivedRun.stderr);
		assert.match(archivedRun.stdout, /\(archived\)/);
		assert.match(archivedRun.stdout, /archived text\s*$/);

		const inboxRun = await run(["ref", `[pixip-ref=inbox/${sent.id}]`, "--data-dir", paths.dataDir]);
		assert.equal(inboxRun.code, 0, inboxRun.stderr);
		assert.match(inboxRun.stdout, /subject: ref inbox subject/);
		assert.match(inboxRun.stdout, /purpose: deliverable/);
		assert.match(inboxRun.stdout, /sender: live session/);
		assert.match(inboxRun.stdout, /ref inbox body\s*$/);

		const jsonRun = await run(["ref", liveTag, "--data-dir", paths.dataDir, "--json"]);
		assert.equal(jsonRun.code, 0, jsonRun.stderr);
		const parsed = JSON.parse(jsonRun.stdout) as Record<string, unknown>;
		assert.equal(parsed["ok"], true);
		assert.equal(parsed["kind"], "history");
		assert.equal(parsed["role"], "assistant");
		assert.equal(parsed["entryId"], "e2");
		assert.equal(parsed["text"], "live answer");
		assert.equal(parsed["truncated"], false);
		const session = parsed["session"] as Record<string, unknown>;
		assert.equal(session["logicalId"], live.logicalId);
		assert.equal(session["cwd"], paths.dir);
		assert.equal(session["archived"], false);

		const longRun = await run([
			"ref",
			`[pixip-ref=history/${live.logicalId}/e3]`,
			"--data-dir",
			paths.dataDir,
			"--json",
		]);
		assert.equal(longRun.code, 0, longRun.stderr);
		const long = JSON.parse(longRun.stdout) as Record<string, unknown>;
		assert.equal(long["truncated"], true);
		assert.match(String(long["text"]), /truncated \(\d+ characters omitted\)/);

		const deletedRun = await run(["ref", `[pixip-ref=inbox/${deleted.id}]`, "--data-dir", paths.dataDir]);
		assert.equal(deletedRun.code, 2);
		assert.match(deletedRun.stderr, /was deleted/);

		const unknownInbox = await run(["ref", "[pixip-ref=inbox/does-not-exist]", "--data-dir", paths.dataDir]);
		assert.equal(unknownInbox.code, 2);
		assert.match(unknownInbox.stderr, /unknown inbox message/);

		const unknownSession = await run(["ref", "[pixip-ref=history/nope/e1]", "--data-dir", paths.dataDir]);
		assert.equal(unknownSession.code, 2);
		assert.match(unknownSession.stderr, /unknown session/);

		const unknownEntry = await run([
			"ref",
			`[pixip-ref=history/${live.logicalId}/missing]`,
			"--data-dir",
			paths.dataDir,
		]);
		assert.equal(unknownEntry.code, 2);
		assert.match(unknownEntry.stderr, /unknown entry/);

		const malformed = await run(["ref", "[ref=history/a/b]", "--data-dir", paths.dataDir]);
		assert.equal(malformed.code, 1);
		assert.match(malformed.stderr, /usage: pixip ref/);

		const noArg = await run(["ref", "--data-dir", paths.dataDir]);
		assert.equal(noArg.code, 1);
		assert.match(noArg.stderr, /usage: pixip ref/);
	});

	it("lists ref in the top-level help", async () => {
		const help = await run(["--help"]);
		assert.equal(help.code, 0, help.stderr);
		assert.match(help.stdout, /ref <tag> \[--json\]/);
	});

	it("reports a trashed session as unavailable", async () => {
		const paths = await fixtureRoot("pixip-ref-cli-");
		const hub = hubFor(paths, { trashGraceMs: 60_000 });
		const deleted = await hub.create(paths.dir, "deleted session");
		await sessionFile(
			paths,
			[infoEntry("deleted session"), JSON.stringify(entry("d1", "user", "gone", 1735689600400, null))],
			{ id: deleted.id, cwd: paths.dir },
		);
		await hub.stop(deleted.id);
		await hub.deleteSession(deleted.id);
		await hub.shutdown();

		const result = await run(["ref", `[pixip-ref=history/${deleted.logicalId}/d1]`, "--data-dir", paths.dataDir]);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /was deleted/);
	});

	it("reads an inbox file that still has no deleted array", async () => {
		const paths = await fixtureRoot("pixip-ref-cli-");
		await mkdir(paths.dataDir, { recursive: true });
		await writeFile(
			join(paths.dataDir, "inbox.json"),
			JSON.stringify({
				version: 1,
				messages: [
					{
						id: "legacy-id",
						subject: "legacy subject",
						body: "legacy body",
						purpose: "no-rush",
						createdAt: "2026-11-21T00:00:00.000Z",
						readAt: null,
						archivedAt: null,
						sender: { logicalId: "session-1", name: "Legacy sender" },
					},
				],
			}),
		);

		const result = await run(["ref", "[pixip-ref=inbox/legacy-id]", "--data-dir", paths.dataDir]);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /legacy subject/);
		assert.match(result.stdout, /legacy body\s*$/);
	});
});

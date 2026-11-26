import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { InboxStore, MAX_INBOX_BODY_BYTES } from "../src/inbox.ts";
import { startServer } from "../src/server.ts";
import {
	cleanupRoots,
	exists,
	fixtureRoot,
	hubFor,
	infoEntry,
	sessionFile,
	spawns,
	tempRoot,
	type TestPaths,
} from "./helpers/harness.ts";

const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
	const clean = { ...process.env };
	delete clean["PIXIP_DAEMON_URL"];
	delete clean["PIXIP_INBOX_TOKEN"];
	delete clean["PIXIP_SESSION_ID"];
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ env: { ...clean, ...env }, timeout: 60_000 },
			(error, stdout, stderr) => {
				const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code: exit, stdout, stderr });
			},
		);
	});
}

function messageInput(subject: string, extra: { body?: string; purpose?: "attention-needed" } = {}) {
	return {
		subject,
		body: extra.body ?? `${subject} body`,
		purpose: extra.purpose ?? ("attention-needed" as const),
		sender: { logicalId: "session-1", name: "Session One", cwd: "/work" },
	};
}

async function boot(paths: TestPaths, inboxToken?: string) {
	const hub = hubFor(paths, inboxToken ? { inboxToken } : {});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	hub.setDaemonUrl(server.url);
	return { hub, server };
}

after(async () => {
	await cleanupRoots();
});

describe("inbox store", () => {
	it("round-trips messages, writes atomically and recovers from a malformed file", async () => {
		const dir = await tempRoot("pixip-inbox-");
		const path = join(dir, "inbox.json");
		const logs: string[] = [];
		const store = new InboxStore({ path, log: (line) => logs.push(line) });
		const sent = await store.add(messageInput("first"));
		assert.equal((await store.all()).length, 1);
		assert.equal(sent.readAt, null);
		const raw = JSON.parse(await readFile(path, "utf8")) as { version: number; messages: unknown[] };
		assert.equal(raw.version, 1);
		assert.equal(raw.messages.length, 1);
		assert.equal(await exists(`${path}.${process.pid}.tmp`), false);

		const reopened = new InboxStore({ path, log: (line) => logs.push(line) });
		assert.equal((await reopened.all())[0]?.subject, "first");

		await writeFile(path, "{ not json");
		const recovered = new InboxStore({ path, log: (line) => logs.push(line) });
		await recovered.add(messageInput("after corruption"));
		assert.deepEqual(
			(await recovered.all()).map((message) => message.subject),
			["after corruption"],
		);
		assert.ok(logs.some((line) => line.includes("malformed")));
	});

	it("rejects bodies over the cap and purposes outside the list", async () => {
		const dir = await tempRoot("pixip-inbox-");
		const store = new InboxStore({ path: join(dir, "inbox.json") });
		await assert.rejects(
			() => store.add({ ...messageInput("too big"), body: "x".repeat(MAX_INBOX_BODY_BYTES + 1) }),
			/body is too large/,
		);
		await assert.rejects(
			() => store.add({ ...messageInput("bad purpose"), purpose: "urgent" as never }),
			/purpose must be one of/,
		);
	});

	it("evicts archived, then read, then unread with a log line", async () => {
		const dir = await tempRoot("pixip-inbox-");
		const logs: string[] = [];
		const store = new InboxStore({ path: join(dir, "inbox.json"), limit: 3, log: (line) => logs.push(line) });
		const first = await store.add(messageInput("read"));
		const second = await store.add(messageInput("archived"));
		const third = await store.add(messageInput("unread"));
		await store.markRead(first.id);
		await store.archive(second.id);

		await store.add(messageInput("fourth"));
		assert.deepEqual(
			(await store.all()).map((message) => message.subject),
			["read", "unread", "fourth"],
		);
		await store.add(messageInput("fifth"));
		assert.deepEqual(
			(await store.all()).map((message) => message.subject),
			["unread", "fourth", "fifth"],
		);
		assert.equal(
			logs.some((line) => line.startsWith("inbox full")),
			false,
		);
		await store.add(messageInput("sixth"));
		assert.deepEqual(
			(await store.all()).map((message) => message.subject),
			["fourth", "fifth", "sixth"],
		);
		assert.ok(logs.some((line) => line.includes("evicted unread")));
		assert.equal(
			(await store.all()).some((message) => message.id === third.id),
			false,
		);
	});

	it("archives, restores, reads and deletes", async () => {
		const dir = await tempRoot("pixip-inbox-");
		const store = new InboxStore({ path: join(dir, "inbox.json") });
		const sent = await store.add(messageInput("one"));
		await store.archive(sent.id);
		assert.deepEqual(await store.snapshot(), []);
		assert.equal((await store.snapshot({ archived: true })).length, 1);
		await store.restore(sent.id);
		assert.equal((await store.snapshot()).length, 1);
		assert.equal(await store.markRead("all"), 1);
		assert.equal((await store.snapshot({ filter: "unread" })).length, 0);
		await store.delete(sent.id);
		assert.deepEqual(await store.all(), []);
		const tombstones = await store.tombstones();
		assert.equal(tombstones.length, 1);
		assert.equal(tombstones[0]?.id, sent.id);
		assert.ok(tombstones[0]?.deletedAt);
		const raw = JSON.parse(await readFile(join(dir, "inbox.json"), "utf8")) as {
			deleted: Array<{ id: string }>;
		};
		assert.deepEqual(
			raw.deleted.map((item) => item.id),
			[sent.id],
		);
		// A fresh store sees the tombstone too, so `pixip ref` can say "deleted".
		assert.equal((await new InboxStore({ path: join(dir, "inbox.json") }).tombstones())[0]?.id, sent.id);
		await assert.rejects(() => store.delete(sent.id), /unknown inbox message/);
	});
});

describe("hub inbox", () => {
	it("attributes a send to the logical session and keeps the snapshot after deletion", async () => {
		const paths = await fixtureRoot("pixip-inbox-hub-");
		const hub = hubFor(paths);
		const created = await hub.create(paths.dir, "inbox sender");
		await sessionFile(paths, [infoEntry("inbox sender")], { id: created.id, cwd: paths.dir });
		const frames: string[] = [];
		hub.watch((frame) => frames.push(frame));

		const sent = await hub.inboxSend({
			subject: "needs a decision",
			body: "pick one",
			purpose: "attention-needed",
			sessionId: created.logicalId,
		});
		assert.equal(sent.sender.logicalId, created.logicalId);
		assert.equal(sent.sender.cwd, paths.dir);
		assert.equal(sent.sender.piId, created.id);
		assert.ok(["running", "idle"].includes(sent.senderStatus), sent.senderStatus);
		assert.ok(frames.some((frame) => frame.includes('"t":"inbox"') && frame.includes('"unread":1')));

		await hub.stop(created.id);
		const stopped = await hub.inboxList();
		assert.equal(stopped.messages[0]?.senderStatus, "stopped");
		await hub.deleteSession(created.id);
		const deleted = await hub.inboxList();
		assert.equal(deleted.messages[0]?.senderStatus, "deleted");
		assert.equal(deleted.messages[0]?.sender.name, sent.sender.name);

		await hub.shutdown();
		const restarted = hubFor(paths);
		const list = await restarted.inboxList();
		assert.equal(list.total, 1);
		assert.equal(list.messages[0]?.body, "pick one");
		assert.equal(list.messages[0]?.senderStatus, "deleted");
		await restarted.shutdown();
	});

	it("hides an empty inbox until the extension announces itself, once", async () => {
		const paths = await fixtureRoot("pixip-inbox-announce-");
		const hub = hubFor(paths);
		const frames: string[] = [];
		hub.watch((frame) => frames.push(frame));
		try {
			const empty = await hub.inboxSummary();
			assert.equal(empty.newest, undefined);
			assert.equal(empty.extension, undefined);

			assert.equal(await hub.inboxAnnounce(), true);
			assert.equal((await hub.inboxSummary()).extension, true);
			assert.equal(frames.filter((frame) => frame.includes('"extension":true')).length, 1);

			assert.equal(await hub.inboxAnnounce(), false);
			assert.equal(frames.filter((frame) => frame.includes('"t":"inbox"')).length, 1);
		} finally {
			await hub.shutdown();
		}

		// In memory only: a new daemon run waits for the next child to announce.
		const restarted = hubFor(paths);
		try {
			assert.equal(await restarted.inboxSummary().then((summary) => summary.extension), undefined);
		} finally {
			await restarted.shutdown();
		}
	});
});

describe("inbox routes", () => {
	it("sends, lists, reads, archives, restores and deletes", async () => {
		const paths = await fixtureRoot("pixip-inbox-routes-");
		const { hub, server } = await boot(paths);
		try {
			const sent = await fetch(new URL("api/inbox", server.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "route", body: "hello", purpose: "deliverable" }),
			});
			assert.equal(sent.status, 200);
			const created = (await sent.json()) as { message: { id: string } };

			const listed = (await (await fetch(new URL("api/inbox", server.url))).json()) as {
				messages: Array<{ id: string; senderStatus: string }>;
				unread: number;
			};
			assert.equal(listed.unread, 1);
			assert.equal(listed.messages[0]?.senderStatus, "deleted");
			assert.equal(listed.messages[0]?.id, created.message.id);

			const read = await fetch(new URL(`api/inbox/${created.message.id}/read`, server.url), { method: "POST" });
			assert.equal(read.status, 200);
			const unread = (await (await fetch(new URL("api/inbox?filter=unread", server.url))).json()) as {
				messages: unknown[];
			};
			assert.equal(unread.messages.length, 0);

			await fetch(new URL(`api/inbox/${created.message.id}/archive`, server.url), { method: "POST" });
			const visible = (await (await fetch(new URL("api/inbox", server.url))).json()) as { messages: unknown[] };
			assert.equal(visible.messages.length, 0);
			const archived = (await (await fetch(new URL("api/inbox?archived=1", server.url))).json()) as {
				messages: unknown[];
			};
			assert.equal(archived.messages.length, 1);
			await fetch(new URL(`api/inbox/${created.message.id}/restore`, server.url), { method: "POST" });
			const restored = (await (await fetch(new URL("api/inbox", server.url))).json()) as { messages: unknown[] };
			assert.equal(restored.messages.length, 1);

			const deleted = await fetch(new URL(`api/inbox/${created.message.id}`, server.url), { method: "DELETE" });
			assert.equal(deleted.status, 200);
			const empty = (await (await fetch(new URL("api/inbox", server.url))).json()) as { total: number };
			assert.equal(empty.total, 0);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("guards the API when an inbox token is configured", async () => {
		const paths = await fixtureRoot("pixip-inbox-routes-");
		const { hub, server } = await boot(paths, "secret");
		try {
			const refused = await fetch(new URL("api/inbox", server.url));
			assert.equal(refused.status, 401);
			const wrong = await fetch(new URL("api/inbox", server.url), {
				headers: { authorization: "Bearer nope" },
			});
			assert.equal(wrong.status, 401);
			const allowed = await fetch(new URL("api/inbox", server.url), {
				headers: { authorization: "Bearer secret" },
			});
			assert.equal(allowed.status, 200);
			const postRefused = await fetch(new URL("api/inbox", server.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "x", body: "y", purpose: "no-rush" }),
			});
			assert.equal(postRefused.status, 401);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("accepts the extension announce behind the same token seam", async () => {
		const paths = await fixtureRoot("pixip-inbox-extension-");
		const { hub, server } = await boot(paths, "secret");
		const announce = (headers: Record<string, string> = {}) =>
			fetch(new URL("api/inbox/extension", server.url), { method: "POST", headers });
		try {
			assert.equal((await announce()).status, 401);
			const allowed = await announce({ authorization: "Bearer secret" });
			assert.equal(allowed.status, 200);
			assert.deepEqual(await allowed.json(), { ok: true, announced: true });
			const again = await announce({ authorization: "Bearer secret" });
			assert.deepEqual(await again.json(), { ok: true, announced: false });

			const summary = await hub.inboxSummary();
			assert.equal(summary.extension, true);
			assert.equal(summary.newest, undefined);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("injects PIXIP_DAEMON_URL always and PIXIP_INBOX_TOKEN only when configured", async () => {
		const paths = await fixtureRoot("pixip-inbox-env-");
		const { hub, server } = await boot(paths, "secret");
		try {
			await hub.create(paths.dir, "env");
			const record = (await spawns(paths)).find((item) => item.type === "spawn");
			assert.equal(record?.["pixipDaemonUrl"], server.url.replace(/\/$/, ""));
			assert.equal(record?.["pixipInboxToken"], "secret");
		} finally {
			await server.close();
			await hub.shutdown();
		}

		const openPaths = await fixtureRoot("pixip-inbox-env-");
		const open = await boot(openPaths);
		try {
			await open.hub.create(openPaths.dir, "env open");
			const record = (await spawns(openPaths)).find((item) => item.type === "spawn");
			assert.equal(record?.["pixipDaemonUrl"], open.server.url.replace(/\/$/, ""));
			assert.equal(record?.["pixipInboxToken"], null);
		} finally {
			await open.server.close();
			await open.hub.shutdown();
		}
	});
});

describe("inbox CLI", () => {
	it("sends, lists and reads through PIXIP_DAEMON_URL", async () => {
		const paths = await fixtureRoot("pixip-inbox-cli-");
		const { hub, server } = await boot(paths);
		try {
			const created = await hub.create(paths.dir, "cli sender");
			await sessionFile(paths, [infoEntry("cli sender")], { id: created.id, cwd: paths.dir });
			const env = {
				PIXIP_DAEMON_URL: server.url,
				PIXIP_SESSION_ID: created.logicalId,
			};
			const sent = await cli(["inbox", "send", "--subject", "cli message", "the body"], env);
			assert.equal(sent.code, 0, sent.stderr);
			assert.match(sent.stdout, /sent /);

			const listed = await cli(["inbox", "list", "--json"], env);
			assert.equal(listed.code, 0, listed.stderr);
			const list = JSON.parse(listed.stdout) as {
				messages: Array<{ id: string; subject: string; readAt: string | null; sender: { logicalId: string } }>;
			};
			assert.equal(list.messages[0]?.subject, "cli message");
			assert.equal(list.messages[0]?.sender.logicalId, created.logicalId);
			assert.equal(list.messages[0]?.readAt, null);

			const short = list.messages[0]?.id.slice(0, 8) ?? "";
			const read = await cli(["inbox", "read", short], env);
			assert.equal(read.code, 0, read.stderr);
			assert.match(read.stdout, /read/);
			const reread = (await cli(["inbox", "list", "--json"], env)).stdout;
			assert.notEqual((JSON.parse(reread) as { messages: Array<{ readAt: string | null }> }).messages[0]?.readAt, null);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("fails clearly when no daemon is running", async () => {
		const dir = await tempRoot("pixip-inbox-cli-");
		const result = await cli(["inbox", "list", "--data-dir", dir]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /pixip is not running/);
	});
});

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { join } from "node:path";

import WebSocket from "ws";

import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { cleanupRoots, exists, fixtureRoot, hubFor, spawns, waitFor, type TestPaths } from "./helpers/harness.ts";

const REQUEST = [
	{
		type: "extension_ui_request",
		id: "ui-1",
		method: "select",
		title: "Pick one",
		options: ["Alpha", "Beta"],
	},
];

interface Inbox {
	frames: Array<Record<string, unknown>>;
	send: (frame: Record<string, unknown>) => void;
	close: () => void;
}

async function connect(url: string, id: string): Promise<Inbox> {
	const ws = new WebSocket(`${url}ws?session=${encodeURIComponent(id)}`);
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (raw) => {
		try {
			frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
		} catch {
			// the assertions below would fail on a broken frame anyway
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return {
		frames,
		send: (frame) => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
	};
}

async function boot(
	paths: TestPaths,
	pendingUiGraceMs = 1000,
	env: Record<string, string> = {},
	extra: Record<string, unknown> = {},
): Promise<{ hub: Hub; server: RunningServer; id: string; logicalId?: string; url: string }> {
	const hub = hubFor(paths, {
		pendingUiGraceMs,
		reaskReplyMs: 1000,
		...extra,
		env: { FAKE_PI_ON_PROMPT: JSON.stringify(REQUEST), ...env },
	});
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: paths.clientDir,
		log: () => {},
	});
	const created = await hub.create(paths.dir);
	return { hub, server, id: created.id, logicalId: created.logicalId, url: server.url };
}

const uiRequests = (inbox: Inbox) =>
	inbox.frames
		.filter((frame) => frame["t"] === "event")
		.map((frame) => frame["ev"] as Record<string, unknown> | undefined)
		.filter(
			(event): event is Record<string, unknown> =>
				event?.type === "extension_ui_request" && event["method"] === "select",
		);

const loggedResponses = async (paths: TestPaths) =>
	(await spawns(paths)).filter((record) => record["type"] === "extension_ui_response");

after(async () => {
	await cleanupRoots();
});

describe("pending extension UI", () => {
	it("replays an unanswered dialog after the browser reconnects", async () => {
		const paths = await fixtureRoot("pixip-pending-ui-", { logName: "rpc.jsonl" });
		const { hub, server, id, url } = await boot(paths);
		const first = await connect(url, id);
		try {
			await waitFor(() => first.frames.some((frame) => frame["t"] === "snapshot"));
			first.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(first).length === 1);
			first.close();

			const second = await connect(url, id);
			try {
				await waitFor(() => uiRequests(second).length === 1);
				const replay = uiRequests(second)[0];
				assert.ok(replay);
				assert.equal(replay["id"], "ui-1");
				assert.equal(replay["title"], "Pick one");
				assert.deepEqual(replay["options"], ["Alpha", "Beta"]);

				second.send({ t: "ui", id: "ui-1", value: "Beta" });
				await waitFor(async () => (await loggedResponses(paths)).some((entry) => entry["id"] === "ui-1"));
			} finally {
				second.close();
			}

			// Answered requests are not replayed to a later tab.
			const third = await connect(url, id);
			try {
				await waitFor(() => third.frames.some((frame) => frame["t"] === "footer"));
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(uiRequests(third).length, 0);
			} finally {
				third.close();
			}
		} finally {
			first.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("cancels a dialog when no client reattaches inside the grace window", async () => {
		const paths = await fixtureRoot("pixip-pending-ui-", { logName: "rpc.jsonl" });
		const { hub, server, id, url } = await boot(paths, 80);
		const inbox = await connect(url, id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(inbox).length === 1);
			inbox.close();

			await waitFor(async () => (await loggedResponses(paths)).some((entry) => entry["id"] === "ui-1"));
			const response = (await loggedResponses(paths)).find((entry) => entry["id"] === "ui-1");
			assert.equal(response?.["cancelled"], true);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("records a timed-out request when the agent agrees and re-asks it on demand", async () => {
		const paths = await fixtureRoot("pixip-pending-ui-", { logName: "rpc.jsonl" });
		const yes = [
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "YES" }] },
			},
		];
		const { hub, server, id, logicalId, url } = await boot(paths, 80, {
			FAKE_PI_ON_TIMEOUT_PROMPT: JSON.stringify(yes),
		});
		const recordFile = join(paths.dataDir, "pending-ui", `${logicalId}.json`);
		const first = await connect(url, id);
		try {
			await waitFor(() => first.frames.some((frame) => frame["t"] === "snapshot"));
			first.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(first).length === 1);
			first.close();

			await waitFor(async () =>
				(await spawns(paths)).some(
					(record) =>
						record["type"] === "prompt" && String(record["text"] ?? "").includes("Should it be offered again"),
				),
			);
			await waitFor(() => exists(recordFile));

			const second = await connect(url, id);
			try {
				await waitFor(() => second.frames.some((frame) => frame["t"] === "snapshot"));
				await waitFor(() => second.frames.some((frame) => frame["t"] === "reasks"));
				const reaskFrame = second.frames.find((frame) => frame["t"] === "reasks");
				const requests = reaskFrame?.["requests"] as Array<Record<string, unknown>>;
				assert.equal(requests[0]?.["id"], "ui-1");
				assert.equal(requests[0]?.["method"], "select");

				second.send({ t: "reask", id: "ui-1", action: "ask" });
				await waitFor(async () =>
					(await spawns(paths)).some(
						(record) => record["type"] === "prompt" && String(record["text"] ?? "").includes("Re-issue this same call"),
					),
				);
				const reaskPrompt = (await spawns(paths)).find(
					(record) => record["type"] === "prompt" && String(record["text"] ?? "").includes("Re-issue this same call"),
				);
				assert.equal(reaskPrompt?.["streamingBehavior"], "followUp");
				await waitFor(async () => !(await exists(recordFile)));
			} finally {
				second.close();
			}
		} finally {
			first.close();
			await server.close();
			await hub.shutdown();
		}
	});

	it("offers more time before cancelling a visible dialog", async () => {
		const paths = await fixtureRoot("pixip-pending-ui-", { logName: "rpc.jsonl" });
		const { hub, server, id, url } = await boot(
			paths,
			1000,
			{},
			{
				pendingUiOpenTimeoutMs: 80,
				pendingUiMoreTimeMs: 1000,
			},
		);
		const inbox = await connect(url, id);
		try {
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "snapshot"));
			inbox.send({ t: "prompt", text: "go" });
			await waitFor(() => uiRequests(inbox).length === 1);
			await waitFor(() => inbox.frames.some((frame) => frame["t"] === "ui_need_time"));
			// The dialog is still waiting: no cancelled response has been sent yet.
			assert.equal((await loggedResponses(paths)).length, 0);
			inbox.send({ t: "ui_more_time", id: "ui-1", more: true });
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal((await loggedResponses(paths)).length, 0);
		} finally {
			inbox.close();
			await server.close();
			await hub.shutdown();
		}
	});
});

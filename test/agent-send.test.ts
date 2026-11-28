import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { AgentDeliveryLog, type AgentDeliveryRecord } from "../src/agentDeliveries.ts";
import type { AgentInfo } from "../src/agents.ts";
import { resolveAgentTarget } from "../src/agents.ts";
import type { Hub } from "../src/hub.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import type { SessionInfo } from "../src/wire.ts";
import {
	cleanupRoots,
	fixtureRoot,
	hubFor,
	infoEntry,
	sessionFile,
	spawns,
	tempRoot,
	type TestPaths,
} from "./helpers/harness.ts";

interface Boot {
	hub: Hub;
	server: RunningServer;
}

async function boot(paths: TestPaths, env: Record<string, string> = {}): Promise<Boot> {
	const hub = hubFor(paths, { env });
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

async function send(
	server: RunningServer,
	target: string,
	body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
	const response = await fetch(new URL(`api/agents/${encodeURIComponent(target)}/messages`, server.url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function agentList(server: RunningServer): Promise<AgentInfo[]> {
	const response = await fetch(new URL("api/agents", server.url));
	const body = (await response.json()) as { agents: AgentInfo[] };
	return body.agents;
}

async function prompts(paths: TestPaths): Promise<Array<Record<string, unknown>>> {
	return (await spawns(paths)).filter((record) => record["type"] === "prompt");
}

after(async () => {
	await cleanupRoots();
});

describe("POST /api/agents/:id/messages", () => {
	it("delivers to an idle target with a local-shell marker and exposes lastDelivery", async () => {
		const paths = await fixtureRoot("pixip-send-idle-");
		const { hub, server } = await boot(paths);
		try {
			const target = await hub.create(paths.dir, "alpha");
			const { status, body } = await send(server, "alpha", { message: "hello there" });
			assert.equal(status, 200);
			assert.equal(body["delivered"], true);
			assert.equal(body["woken"], false);
			assert.equal(body["streaming"], false);
			assert.equal(body["target"]["id"], target.id);
			assert.equal(body["target"]["name"], "alpha");
			assert.equal(body["target"]["stateBefore"], "idle");
			assert.equal(body["target"]["stateAfter"], "idle");
			assert.equal(body["target"]["url"], `http://${new URL(server.url).host}/#s=${encodeURIComponent(target.id)}`);
			assert.equal(typeof body["deliveryId"], "string");
			assert.equal(typeof body["at"], "string");

			const sent = await prompts(paths);
			assert.equal(sent.length, 1);
			assert.equal(sent[0]?.["text"], "[pixip-agent=local-shell]\nhello there");
			assert.equal(sent[0]?.["streamingBehavior"], null);

			const row = (await agentList(server)).find((agent) => agent.id === target.id);
			assert.ok(row?.lastDelivery);
			assert.equal(row.lastDelivery.deliveryId, body["deliveryId"]);
			assert.equal(row.lastDelivery.senderId, "local-shell");
			assert.equal(row.lastDelivery.stateAfter, "idle");
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("answers a malformed percent-encoded target with 400", async () => {
		const paths = await fixtureRoot("pixip-send-bad-target-");
		const { hub, server } = await boot(paths);
		try {
			await hub.create(paths.dir, "alpha");
			const response = await fetch(new URL("api/agents/%E0%A4%A/messages", server.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "hello" }),
			});
			assert.equal(response.status, 400);
			assert.match(((await response.json()) as Record<string, string>)["error"] ?? "", /valid percent-encoded/);
			assert.equal((await prompts(paths)).length, 0, "nothing is delivered");
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("steers a busy target and keeps the caller's sender id in the marker", async () => {
		const paths = await fixtureRoot("pixip-send-busy-");
		const { hub, server } = await boot(paths, { FAKE_PI_IS_STREAMING: "1" });
		try {
			const target = await hub.create(paths.dir, "busy");
			const { status, body } = await send(server, target.id, { message: "change direction", sender: "sender-1" });
			assert.equal(status, 200);
			assert.equal(body["streaming"], true);
			assert.equal(body["woken"], false);
			assert.equal(body["target"]["stateBefore"], "busy");

			const sent = await prompts(paths);
			assert.equal(sent.length, 1);
			assert.equal(sent[0]?.["text"], "[pixip-agent=sender-1]\nchange direction");
			assert.equal(sent[0]?.["streamingBehavior"], "steer");
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("wakes a stopped target before prompting it", async () => {
		const paths = await fixtureRoot("pixip-send-stopped-");
		const { hub, server } = await boot(paths);
		try {
			const target = await hub.create(paths.dir, "sleeping");
			await hub.stop(target.id);
			const { status, body } = await send(server, target.id, { message: "wake up", sender: "sender-2" });
			assert.equal(status, 200);
			assert.equal(body["woken"], true);
			assert.equal(body["target"]["stateBefore"], "stopped");
			assert.equal(body["target"]["stateAfter"], "idle");

			const sent = await prompts(paths);
			assert.equal(sent.at(-1)?.["text"], "[pixip-agent=sender-2]\nwake up");
			assert.equal(sent.at(-1)?.["streamingBehavior"], null);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("restores an archived target and a trashed target by explicit id", async () => {
		const paths = await fixtureRoot("pixip-send-stored-");
		const { hub, server } = await boot(paths);
		try {
			const archived = await hub.create(paths.dir, "archived");
			await hub.stop(archived.id);
			await hub.archive(archived.id);
			const trashed = await hub.create(paths.dir, "trashed");
			await hub.stop(trashed.id);
			await hub.deleteSession(trashed.id);

			// Stored rows are not reachable by name, only by explicit id.
			const byName = await send(server, "archived", { message: "nope" });
			assert.equal(byName.status, 404);
			assert.match(byName.body["error"], /unknown agent "archived"/);

			const fromArchive = await send(server, archived.id, { message: "from archive" });
			assert.equal(fromArchive.status, 200);
			assert.equal(fromArchive.body["woken"], true);
			assert.equal(fromArchive.body["target"]["stateBefore"], "stopped");

			const fromTrash = await send(server, trashed.id, { message: "from trash" });
			assert.equal(fromTrash.status, 200);
			assert.equal(fromTrash.body["woken"], true);

			assert.equal((await hub.listArchived()).length, 0);
			assert.equal((await hub.listTrash()).length, 0);
			const active = await hub.list();
			assert.ok(active.some((session) => session.logicalId === archived.logicalId));
			assert.ok(active.some((session) => session.logicalId === trashed.logicalId));
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("refuses ambiguous names and prefixes with a candidate list", async () => {
		const paths = await fixtureRoot("pixip-send-ambiguous-");
		await sessionFile(paths, [infoEntry("dup")], { id: "id-dup-1", cwd: paths.dir });
		await sessionFile(paths, [infoEntry("dup")], { id: "id-dup-2", cwd: paths.dir });
		const { hub, server } = await boot(paths);
		try {
			const byName = await send(server, "dup", { message: "hello" });
			assert.equal(byName.status, 409);
			assert.match(byName.body["error"], /ambiguous agent "dup"; matches:/);
			assert.equal(byName.body["candidates"].length, 2);
			assert.deepEqual(
				byName.body["candidates"].map((candidate: { id: string }) => candidate.id),
				["id-dup-1", "id-dup-2"],
			);

			const byPrefix = await send(server, "id-dup", { message: "hello" });
			assert.equal(byPrefix.status, 409);
			assert.equal(byPrefix.body["candidates"].length, 2);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("always prefers an exact id over a name and refuses self-send", async () => {
		const active: SessionInfo = {
			id: "alpha-id",
			logicalId: "alpha-logical",
			name: "beta",
			state: "idle",
			cwd: "/tmp",
			lastActivity: 1,
		};
		const named: SessionInfo = {
			id: "beta-id",
			logicalId: "beta-logical",
			name: "alpha-id",
			state: "idle",
			cwd: "/tmp",
			lastActivity: 2,
		};
		const resolved = resolveAgentTarget([active, named], [], [], "alpha-id");
		assert.equal(resolved.info.id, "alpha-id");

		const paths = await fixtureRoot("pixip-send-self-");
		const { hub, server } = await boot(paths);
		try {
			const target = await hub.create(paths.dir, "self");
			const self = await send(server, target.id, { message: "loop", sender: target.logicalId });
			assert.equal(self.status, 400);
			assert.match(self.body["error"], /cannot send an agent message to the sender session/);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("rejects unknown targets, empty text and unsafe sender ids", async () => {
		const paths = await fixtureRoot("pixip-send-errors-");
		const { hub, server } = await boot(paths);
		try {
			const target = await hub.create(paths.dir, "target");
			const unknown = await send(server, "no-such-agent", { message: "hello" });
			assert.equal(unknown.status, 404);
			assert.match(unknown.body["error"], /unknown agent "no-such-agent"/);

			const empty = await send(server, target.id, { message: "   " });
			assert.equal(empty.status, 400);
			assert.match(empty.body["error"], /message must not be empty/);

			const control = await send(server, target.id, { message: "hello", sender: "bad\nsender" });
			assert.equal(control.status, 400);
			assert.match(control.body["error"], /sender must not contain control characters/);

			const long = await send(server, target.id, { message: "hello", sender: "x".repeat(129) });
			assert.equal(long.status, 400);
			assert.match(long.body["error"], /sender must be 128 characters or fewer/);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("keeps lastDelivery across a daemon restart", async () => {
		const paths = await fixtureRoot("pixip-send-restart-");
		const first = await boot(paths);
		let deliveryId: string;
		let targetId: string;
		try {
			const target = await first.hub.create(paths.dir, "alpha");
			targetId = target.id;
			const sent = await send(first.server, target.id, { message: "persist me" });
			deliveryId = sent.body["deliveryId"] as string;
		} finally {
			await first.server.close();
			await first.hub.shutdown();
		}

		const second = await boot(paths);
		try {
			const row = (await agentList(second.server)).find((agent) => agent.id === targetId);
			assert.ok(row?.lastDelivery);
			assert.equal(row.lastDelivery.deliveryId, deliveryId);
			assert.equal(row.lastDelivery.senderId, "local-shell");
		} finally {
			await second.server.close();
			await second.hub.shutdown();
		}
	});

	it("bounds the persisted delivery log and reloads it", async () => {
		const dir = await tempRoot("pixip-deliveries-");
		const path = join(dir, "agent-deliveries.json");
		const log = new AgentDeliveryLog({ path, limit: 3 });
		const at = "2026-11-21T00:00:00.000Z";
		for (let index = 0; index < 5; index += 1) {
			const record: AgentDeliveryRecord = {
				deliveryId: `d-${index}`,
				targetId: "pi-1",
				targetLogicalId: "logical-1",
				senderId: "sender",
				at,
				delivered: true,
				woken: false,
				streaming: false,
				stateBefore: "idle",
				stateAfter: "idle",
			};
			await log.record(record);
		}
		const stored = JSON.parse(await readFile(path, "utf8")) as AgentDeliveryRecord[];
		assert.deepEqual(
			stored.map((record) => record.deliveryId),
			["d-2", "d-3", "d-4"],
		);

		const reloaded = new AgentDeliveryLog({ path, limit: 3 });
		const latest = await reloaded.lastByLogicalId();
		assert.equal(latest.get("logical-1")?.deliveryId, "d-4");
	});
});

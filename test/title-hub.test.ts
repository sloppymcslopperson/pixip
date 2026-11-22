import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Hub } from "../src/hub.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const roots: string[] = [];
const MODELS = JSON.stringify([
	{ id: "deepseek-v4.1-flash", provider: "fake", contextWindow: 100_000 },
	{ id: "fake-model", provider: "fake", contextWindow: 100_000 },
]);

interface Paths {
	dir: string;
	sessionsDir: string;
	indexPath: string;
	logPath: string;
}

async function fixtureRoot(): Promise<Paths> {
	const dir = await mkdtemp(join(tmpdir(), "pixip-title-"));
	roots.push(dir);
	const paths = {
		dir,
		sessionsDir: join(dir, "sessions"),
		indexPath: join(dir, "sessions.json"),
		logPath: join(dir, "spawns.jsonl"),
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	return paths;
}

function hubFor(paths: Paths, env: Record<string, string> = {}, titleModel?: string): Hub {
	return new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dir,
		indexPath: paths.indexPath,
		idleMs: 0,
		titleModel,
		titleTimeoutMs: 2000,
		extraPiArgs: [],
		env: { FAKE_PI_LOG: paths.logPath, FAKE_PI_MODELS: MODELS, ...env },
		log: () => {},
	});
}

async function records(paths: Paths): Promise<Array<Record<string, unknown>>> {
	return JSON.parse(await readFile(paths.indexPath, "utf8")) as Array<Record<string, unknown>>;
}

async function events(paths: Paths): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(paths.logPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("first-prompt session labels", () => {
	it("labels a new session from a separate one-shot call using the session model", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths, { FAKE_PI_TITLE: "Refactor auth module" });
		const created = await hub.create(paths.dir);
		assert.equal(created.name, undefined);

		await hub.prompt(created.id, "Please refactor the authentication module.");
		await waitFor(async () => (await hub.list()).find((session) => session.id === created.id)?.name === "Refactor auth module");
		assert.equal((await hub.list()).find((session) => session.id === created.id)?.name, "Refactor auth module");
		await waitFor(async () => (await records(paths))[0]?.["nameSource"] === "auto");
		const [record] = await records(paths);
		assert.equal(record?.["nameSource"], "auto");

		const title = (await events(paths)).find((event) => event["type"] === "title");
		assert.ok(title);
		const args = title?.["args"] as string[];
		assert.ok(args.includes("--print"));
		assert.ok(args.includes("--no-session"));
		assert.ok(args.includes("--no-tools"));
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("fake/fake-model"));
		await hub.shutdown();
	});

	it("retries the session model after the first turn when the title call loses the race", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths, {
			FAKE_PI_TITLE: "Retried model title",
			FAKE_PI_TITLE_FAIL_ONCE: join(paths.dir, "title-failed-once"),
			FAKE_PI_ON_PROMPT: JSON.stringify([{ type: "agent_start" }]),
			FAKE_PI_SETTLE: JSON.stringify([{ type: "agent_settled" }]),
			FAKE_PI_SETTLE_DELAY_MS: "300",
		});
		const created = await hub.create(paths.dir);
		await hub.prompt(created.id, "Please refactor the authentication module.");
		await waitFor(async () => (await hub.list()).find((session) => session.id === created.id)?.name === "Retried model title");
		const titles = (await events(paths)).filter((event) => event["type"] === "title");
		assert.equal(titles.length, 2);
		assert.deepEqual((titles[1]?.["args"] as string[]).slice(-3, -1), ["--model", "fake/fake-model"]);
		await hub.shutdown();
	});

	it("never overwrites a manual name, before or after the automatic label", async () => {
		const namedPaths = await fixtureRoot();
		const namedHub = hubFor(namedPaths, { FAKE_PI_TITLE: "Wrong label" });
		const named = await namedHub.create(namedPaths.dir, "Keep my name");
		await namedHub.prompt(named.id, "This should not relabel me.");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal((await namedHub.list()).find((session) => session.id === named.id)?.name, "Keep my name");
		assert.equal((await events(namedPaths)).some((event) => event["type"] === "title"), false);
		assert.equal((await records(namedPaths))[0]?.["nameSource"], "manual");
		await namedHub.shutdown();

		const paths = await fixtureRoot();
		const hub = hubFor(paths, { FAKE_PI_TITLE: "Automatic label" });
		const created = await hub.create(paths.dir);
		await hub.prompt(created.id, "First prompt.");
		await waitFor(async () => (await hub.list()).find((session) => session.id === created.id)?.name === "Automatic label");
		await hub.setName(created.id, "My later name");
		assert.equal((await hub.list()).find((session) => session.id === created.id)?.name, "My later name");
		assert.equal((await records(paths))[0]?.["nameSource"], "manual");
		await hub.prompt(created.id, "Second prompt must not rename.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal((await hub.list()).find((session) => session.id === created.id)?.name, "My later name");
		await hub.shutdown();
	});

	it("falls back locally when the one-shot call fails", async () => {
		const paths = await fixtureRoot();
		const hub = hubFor(paths, { FAKE_PI_TITLE_FAIL: "1" });
		const created = await hub.create(paths.dir);
		await hub.prompt(created.id, "Fix the broken login redirect.");
		await waitFor(async () => (await hub.list()).find((session) => session.id === created.id)?.name === "Fix the broken login redirect");
		await waitFor(async () => (await records(paths))[0]?.["nameSource"] === "auto");
		await hub.shutdown();
	});

	it("prefers the configured title model and falls back to the session model", async () => {
		const configuredPaths = await fixtureRoot();
		const configured = hubFor(configuredPaths, { FAKE_PI_TITLE: "Configured model title" }, "fake-model");
		const first = await configured.create(configuredPaths.dir);
		await configured.prompt(first.id, "Use the configured model.");
		await waitFor(async () => (await configured.list()).find((session) => session.id === first.id)?.name === "Configured model title");
		let title = (await events(configuredPaths)).find((event) => event["type"] === "title");
		assert.deepEqual((title?.["args"] as string[]).slice(-3, -1), ["--model", "fake/fake-model"]);
		await configured.shutdown();

		const fallbackPaths = await fixtureRoot();
		const fallback = hubFor(fallbackPaths, { FAKE_PI_TITLE: "Session model title" }, "missing-model");
		const second = await fallback.create(fallbackPaths.dir);
		await fallback.prompt(second.id, "Use the session model instead.");
		await waitFor(async () => (await fallback.list()).find((session) => session.id === second.id)?.name === "Session model title");
		title = (await events(fallbackPaths)).find((event) => event["type"] === "title");
		assert.deepEqual((title?.["args"] as string[]).slice(-3, -1), ["--model", "fake/fake-model"]);
		await fallback.shutdown();
	});
});

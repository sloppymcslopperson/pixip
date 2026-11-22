// Shared fixture plumbing for Hub and temp-dir tests. Keep the fake Pi path and
// cleanup in one place so a new backend (for example the RPC host) can reuse it.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hub, type HubOptions } from "../../src/hub.ts";

export const FIXTURE = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
export const HOST_FIXTURE = fileURLToPath(new URL("../fixtures/fake-pi-host.mjs", import.meta.url));

export interface TestPaths {
	dir: string;
	dataDir: string;
	sessionsDir: string;
	clientDir: string;
	indexPath: string;
	logPath: string;
	logs: string[];
}

const roots: string[] = [];
let fixtureReady: Promise<void> | undefined;

async function readyFixture(): Promise<void> {
	fixtureReady ??= Promise.all([chmod(FIXTURE, 0o755), chmod(HOST_FIXTURE, 0o755)])
		.then(() => {})
		.catch(() => {});
	await fixtureReady;
}

export interface FixtureOptions {
	/** Keep the sessions dir directly under `dir` instead of under `<dir>/data`. */
	flat?: boolean;
	/** Log filename inside `dir`; defaults to `spawns.jsonl`. */
	logName?: string;
	/** Skip creating the fake client asset directory. */
	client?: boolean;
}

/** Create an isolated temporary root registered with `cleanupRoots`. */
export async function tempRoot(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** Create an isolated root, register it for cleanup, and make the fake Pi executable. */
export async function fixtureRoot(prefix: string, options: FixtureOptions = {}): Promise<TestPaths> {
	await readyFixture();
	const dir = await tempRoot(prefix);
	const dataDir = options.flat ? dir : join(dir, "data");
	const paths: TestPaths = {
		dir,
		dataDir,
		sessionsDir: join(dataDir, "sessions"),
		clientDir: join(dir, "client"),
		indexPath: join(dataDir, "sessions.json"),
		logPath: join(dir, options.logName ?? "spawns.jsonl"),
		logs: [],
	};
	await mkdir(paths.sessionsDir, { recursive: true });
	if (options.client !== false) await mkdir(paths.clientDir, { recursive: true });
	return paths;
}

/** The roots currently registered for cleanup (for teardown that must act first). */
export function testRoots(): readonly string[] {
	return roots;
}

/** Remove every root created by `fixtureRoot`. Call once from an `after` hook. */
export async function cleanupRoots(): Promise<void> {
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** Build a Hub over a fixture root; per-test options and env override the defaults. */
export function hubFor(paths: TestPaths, options: Partial<HubOptions> = {}, env: Record<string, string> = {}): Hub {
	const { env: optionEnv, ...rest } = options;
	return new Hub({
		piBin: FIXTURE,
		sessionsDir: paths.sessionsDir,
		dataDir: paths.dataDir,
		indexPath: paths.indexPath,
		idleMs: 0,
		extraPiArgs: [],
		log: () => {},
		...rest,
		env: { FAKE_PI_LOG: paths.logPath, ...env, ...optionEnv },
	});
}

export interface SessionFileOptions {
	id?: string;
	cwd?: string;
	timestamp?: string;
}

/** Write one JSONL session file into the fixture's sessions dir. */
export async function sessionFile(
	paths: TestPaths,
	lines: string[],
	options: SessionFileOptions = {},
): Promise<{ id: string; path: string }> {
	const id = options.id ?? "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
	const path = join(paths.sessionsDir, `2026-11-21T00-00-00-000Z_${id}.jsonl`);
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		cwd: options.cwd ?? paths.dir,
		timestamp: options.timestamp ?? "2026-11-21T00:00:00.000Z",
	});
	await writeFile(path, [header, ...lines].join("\n") + "\n");
	return { id, path };
}

/** A `session_info` JSONL line with a stable timestamp and optional id. */
export function infoEntry(name: string | null, id = "i1"): string {
	return JSON.stringify({
		type: "session_info",
		id,
		parentId: null,
		timestamp: "2026-11-21T00:00:01.000Z",
		name,
	});
}

/** Poll until `check` is truthy, then return; reject after the timeout. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await Promise.resolve(check()).catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}

/** Read the JSONL records a fake child logged for this fixture. */
export async function spawns(paths: TestPaths): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(paths.logPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Read the session index (`sessions.json`) for this fixture. */
export async function records(paths: TestPaths): Promise<Array<Record<string, unknown>>> {
	return JSON.parse(await readFile(paths.indexPath, "utf8")) as Array<Record<string, unknown>>;
}

/** True when `path` exists. */
export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

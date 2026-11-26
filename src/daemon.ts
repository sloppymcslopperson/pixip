/**
 * Daemon lifecycle for the CLI: pid/state files, detach, health, soft refresh and
 * the hard restart decision. Everything here is data-dir scoped, so parallel
 * instances on another `--port`/`--data-dir` never collide and tests never touch
 * a real daemon.
 *
 * State files:
 * - `<data-dir>/pixip.pid` — bare pid of the serving process;
 * - `<data-dir>/pixip.state.json` — `{pid, host, port, url, startedAt, dataDir,
 *   args, env}`, where `args` are the serve flags and `env` the extra
 *   environment (for example a custom `PIXIP_PI_HOST`) so `restart` can
 *   reproduce the running configuration;
 * - `<data-dir>/pixip.log` — detached stdout/stderr.
 *
 * A "stale" pid is a state file whose pid is no longer alive; `start`, `status`
 * and `stop` clean those instead of failing.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReloadReport } from "./reload.ts";
import type { SessionInfo } from "./wire.ts";
import { spawnEnv } from "./spawnEnv.ts";

export const PID_FILE = "pixip.pid";
export const STATE_FILE = "pixip.state.json";
export const LOG_FILE = "pixip.log";
/** Last `pixip reload` result, written by the daemon for the polling CLI. */
export const RELOAD_FILE = "pixip.reload.json";

export interface DaemonState {
	pid: number;
	host: string;
	port: number;
	url: string;
	startedAt: string;
	dataDir: string;
	/** Serve args (without the subcommand) so `restart` keeps the configuration. */
	args: string[];
	/** Extra environment for a detached start (for example `PIXIP_PI_HOST`). */
	env?: Record<string, string>;
}

export interface DaemonPaths {
	dataDir: string;
	pid: string;
	state: string;
	log: string;
	reload: string;
}

export interface Health {
	ok: boolean;
	wire?: number;
	pid?: number;
	startedAt?: number;
	reloads?: number;
}

export interface RefreshReport {
	reloaded: string[];
	reloads: number;
}

export function daemonPaths(dataDir: string): DaemonPaths {
	return {
		dataDir,
		pid: join(dataDir, PID_FILE),
		state: join(dataDir, STATE_FILE),
		log: join(dataDir, LOG_FILE),
		reload: join(dataDir, RELOAD_FILE),
	};
}

/** Write the last reload result atomically; the CLI polls the mtime. */
export async function writeReloadResult(dataDir: string, report: ReloadReport): Promise<void> {
	const path = daemonPaths(dataDir).reload;
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`);
	await rename(temp, path);
}

/** The script a detached daemon runs: this package's own bin entry. */
export function daemonEntry(): string {
	return fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function readDaemonState(dataDir: string): Promise<DaemonState | undefined> {
	let text: string;
	try {
		text = await readFile(daemonPaths(dataDir).state, "utf8");
	} catch {
		return undefined;
	}
	try {
		const raw = JSON.parse(text) as Partial<DaemonState>;
		if (typeof raw.pid !== "number" || typeof raw.url !== "string") return undefined;
		return {
			pid: raw.pid,
			host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
			port: typeof raw.port === "number" ? raw.port : 0,
			url: raw.url,
			startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date(0).toISOString(),
			dataDir: typeof raw.dataDir === "string" ? raw.dataDir : dataDir,
			args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [],
			env:
				raw.env && typeof raw.env === "object"
					? Object.fromEntries(
							Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
						)
					: undefined,
		};
	} catch {
		return undefined;
	}
}

export async function writeDaemonState(dataDir: string, state: DaemonState): Promise<void> {
	const paths = daemonPaths(dataDir);
	await mkdir(dataDir, { recursive: true });
	const temp = `${paths.state}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
	await rename(temp, paths.state);
	await writeFile(paths.pid, `${state.pid}\n`);
}

export async function clearDaemonState(dataDir: string): Promise<void> {
	const paths = daemonPaths(dataDir);
	await unlink(paths.pid).catch(() => {});
	await unlink(paths.state).catch(() => {});
}

/**
 * The live daemon for this data dir, cleaning stale files on the way. A pid file
 * without a state file cannot be validated, so it is treated as stale too.
 */
export async function runningDaemon(dataDir: string): Promise<DaemonState | undefined> {
	const state = await readDaemonState(dataDir);
	if (state) {
		if (pidAlive(state.pid)) return state;
		await clearDaemonState(dataDir);
		return undefined;
	}
	await unlink(daemonPaths(dataDir).pid).catch(() => {});
	return undefined;
}

function healthUrl(url: string): string {
	return new URL("health", url).toString();
}

export async function fetchHealth(url: string, timeoutMs = 2000): Promise<Health> {
	const response = await fetch(healthUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`health returned ${response.status}`);
	return (await response.json()) as Health;
}

/** Poll `/health` until the daemon answers (and, when given, reports `pid`). */
export async function waitForHealth(url: string, timeoutMs: number, pid?: number): Promise<Health | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const health = await fetchHealth(url, 1000);
			if (health.ok && (pid === undefined || health.pid === pid)) return health;
		} catch {
			// not listening yet
		}
		if (Date.now() >= deadline) return undefined;
		await delay(50);
	}
}

export async function fetchSessions(url: string, timeoutMs = 3000): Promise<SessionInfo[]> {
	const response = await fetch(new URL("api/sessions", url), { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`session list returned ${response.status}`);
	return (await response.json()) as SessionInfo[];
}

/** Soft refresh: assets, command policy, session index and the catalog alias. */
export async function refreshDaemon(dataDir: string): Promise<RefreshReport> {
	const state = await runningDaemon(dataDir);
	if (!state) throw new Error(`pixip is not running for ${dataDir}`);
	const response = await fetch(new URL("api/refresh", state.url), {
		method: "POST",
		signal: AbortSignal.timeout(10_000),
	});
	const body = (await response.json().catch(() => ({}))) as Partial<RefreshReport> & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `refresh returned ${response.status}`);
	return {
		reloaded: Array.isArray(body.reloaded) ? body.reloaded.map(String) : [],
		reloads: typeof body.reloads === "number" ? body.reloads : 0,
	};
}

export async function portAvailable(host: string, port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, host, () => probe.close(() => resolve(true)));
	});
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			if (!pidAlive(pid)) return resolve(true);
			if (Date.now() >= deadline) return resolve(false);
			setTimeout(tick, 50);
		};
		tick();
	});
}

/**
 * Signal, wait, then SIGKILL; always clears a stale pid file. A restart passes
 * `SIGUSR2` so the old daemon can announce the replacement before closing.
 */
export async function stopDaemon(
	dataDir: string,
	waitMs = 10_000,
	signal: NodeJS.Signals = "SIGTERM",
): Promise<{ stopped: boolean; state?: DaemonState }> {
	const state = await runningDaemon(dataDir);
	if (!state) return { stopped: false };
	try {
		process.kill(state.pid, signal);
	} catch {
		// already gone: fall through to the liveness check
	}
	let exited = await waitForPidExit(state.pid, waitMs);
	if (!exited) {
		try {
			process.kill(state.pid, "SIGKILL");
		} catch {
			// ignore
		}
		exited = await waitForPidExit(state.pid, 2000);
	}
	if (exited) await clearDaemonState(dataDir);
	return { stopped: exited, state };
}

/** Spawn a detached serve process and wait until it reports healthy. */
export async function startDaemon(input: {
	dataDir: string;
	args: string[];
	/** Extra environment for the detached serve process. */
	env?: Record<string, string>;
	timeoutMs?: number;
}): Promise<DaemonState> {
	const { dataDir, args, env, timeoutMs = 15_000 } = input;
	const paths = daemonPaths(dataDir);
	await mkdir(join(dataDir, "sessions"), { recursive: true });
	const log = await open(paths.log, "a");
	try {
		const child = spawn(process.execPath, [daemonEntry(), "run", ...args], {
			detached: true,
			stdio: ["ignore", log.fd, log.fd],
			cwd: process.cwd(),
			env: { ...spawnEnv(), ...env },
		});
		child.unref();
		let exited = false;
		child.once("exit", () => {
			exited = true;
		});
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const state = await readDaemonState(dataDir);
			if (state && state.pid === child.pid) {
				const health = await waitForHealth(state.url, 2000, state.pid);
				if (health) return state;
			}
			if (exited) break;
			await delay(50);
		}
		const tail = await readLogTail(dataDir, 20).catch(() => "");
		throw new Error(`pixip did not start (see ${paths.log})${tail ? `\n${tail.trimEnd()}` : ""}`);
	} finally {
		await log.close();
	}
}

/** Sessions that are not safely restartable yet (`idle`/`stopped`/`error` are). */
export function busySessions(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.filter(
		(session) => session.state !== "idle" && session.state !== "stopped" && session.state !== "error",
	);
}

export function describeSessions(sessions: SessionInfo[]): string {
	return sessions.map((session) => `${session.name ?? session.id.slice(0, 8)} (${session.state})`).join(", ");
}

export async function readLogTail(dataDir: string, lines = 200): Promise<string> {
	const path = daemonPaths(dataDir).log;
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error(`no log at ${path}`);
	}
	const all = text.split("\n");
	if (all.at(-1) === "") all.pop();
	const tail = all.slice(-Math.max(1, lines));
	return tail.length > 0 ? `${tail.join("\n")}\n` : "";
}

export async function logSize(dataDir: string): Promise<number> {
	return (await stat(daemonPaths(dataDir).log)).size;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

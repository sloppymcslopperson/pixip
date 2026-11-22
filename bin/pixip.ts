#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";
import {
	busySessions,
	clearDaemonState,
	daemonPaths,
	delay,
	describeSessions,
	fetchHealth,
	fetchSessions,
	logSize,
	portAvailable,
	readDaemonState,
	readLogTail,
	refreshDaemon,
	runningDaemon,
	startDaemon,
	stopDaemon,
	waitForHealth,
	writeDaemonState,
} from "../src/daemon.ts";
import type { SessionInfo } from "../src/wire.ts";

/**
 * pixip — supervisor + web UI for Pi sessions.
 *
 * `--data-dir` is the isolation boundary used for testing: Pi runs with
 * `--session-dir <data-dir>/sessions`, so the prototype never touches the real
 * `~/.agent/sessions`. The daemon's pid, state and log also live there, so two
 * instances on different `--port`/`--data-dir` never collide.
 *
 * Bare `pixip` serves in the foreground (as before). `start` detaches the same
 * serve path; `stop`/`status`/`logs`/`refresh`/`restart` manage it.
 */

type Command = "serve" | "start" | "stop" | "status" | "logs" | "refresh" | "restart";

const SUBCOMMANDS = new Set<string>(["start", "stop", "status", "logs", "refresh", "restart"]);

interface Options {
	host: string;
	port: number;
	dataDir: string;
	piBin: string;
	idleMs: number;
	titleModel: string;
	dev: boolean;
	allowCommands: string[];
	denyCommands: string[];
	noBash: boolean;
	/** `status --json` */
	json: boolean;
	/** `logs -f` */
	follow: boolean;
	/** `logs --lines N` */
	lines: number;
	/** `restart --force` */
	force: boolean;
	/** `restart --when-idle` */
	whenIdle: boolean;
	/** `restart --timeout <seconds>` */
	timeoutS: number;
	/** Internal: this process is the detached restart helper. */
	detached: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		host: "127.0.0.1",
		port: 8137,
		dataDir: resolve("tmp/dev"),
		piBin: "pi",
		idleMs: 15 * 60_000,
		titleModel: process.env["PIXIP_TITLE_MODEL"] ?? "",
		dev: false,
		allowCommands: [],
		denyCommands: [],
		noBash: false,
		json: false,
		follow: false,
		lines: 200,
		force: false,
		whenIdle: false,
		timeoutS: 300,
		detached: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		switch (arg) {
			case "--host":
				options.host = next();
				break;
			case "--port":
				options.port = Number(next());
				break;
			case "--data-dir":
				options.dataDir = resolve(next());
				break;
			case "--pi":
				options.piBin = next();
				break;
			case "--idle-ms":
				options.idleMs = Number(next());
				break;
			case "--title-model":
				options.titleModel = next();
				break;
			case "--dev":
				options.dev = true;
				break;
			case "--allow-command":
				options.allowCommands.push(next());
				break;
			case "--deny-command":
				options.denyCommands.push(next());
				break;
			case "--no-bash":
				options.noBash = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "-f":
			case "--follow":
				options.follow = true;
				break;
			case "--lines":
				options.lines = Number(next());
				break;
			case "--force":
				options.force = true;
				break;
			case "--when-idle":
				options.whenIdle = true;
				break;
			case "--timeout":
				options.timeoutS = Number(next());
				break;
			case "--detached":
				// Internal flag of the restart helper; not part of the public surface.
				options.detached = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new Error("--port must be an integer between 0 and 65535");
	}
	if (!Number.isFinite(options.idleMs) || options.idleMs < 0) throw new Error("--idle-ms must be 0 or more");
	if (!Number.isInteger(options.lines) || options.lines < 1) throw new Error("--lines must be 1 or more");
	if (!Number.isFinite(options.timeoutS) || options.timeoutS < 0) throw new Error("--timeout must be 0 or more");
	return options;
}

function printHelp(): void {
	const serveOptions = `  --host <address>    bind address (default 127.0.0.1)
  --port <number>     port (default 8137)
  --data-dir <path>   isolation root; sessions, pixip.pid, pixip.state.json
                      and pixip.log live here (default ./tmp/dev), never
                      ~/.agent/sessions
  --pi <path>         pi executable (default: pi from PATH)
  --idle-ms <ms>      detach an idle session after this long, keeping its JSONL
                      for resume (default 900000; 0 disables)
  --title-model <p/id> model for the automatic 3-5 word session label
                      (default: the session's current model; env: PIXIP_TITLE_MODEL)
  --dev               re-read client assets per request (no restart on CSS/JS edits)
  --allow-command <name>
                      allow only these commands (repeatable); merged with
                      <data-dir>/pixip.json and <cwd>/.pixip.json, which can
                      only narrow the result
  --deny-command <name>
                      block a command by name (repeatable); deny wins
  --no-bash           disable !/!! (same as "bash": false in pixip.json)`;
	const usage = `Usage: pixip [command] [options]

Commands:
  (none)|serve        serve in the foreground (default)
  start               detach a daemon, write the pid/state, print the URL
  stop                SIGTERM the daemon and clean its pid file. From inside a
                      pixip session this restarts instead, so an agent cannot
                      take the service down; use a shell outside pixip to stop it
  status [--json]     pid, URL, uptime and session count; non-zero when down
  logs [-f] [--lines] tail <data-dir>/pixip.log (-f follows)
  refresh             soft reload: assets, command policy, session index and the
                      catalog; live children and sockets stay up
  restart [--force] [--when-idle] [--timeout <s>]
                      replace the process; sessions survive in their JSONL.
                      The stop/start runs in a detached helper, so this also
                      works when issued from inside a pixip session (that turn
                      ends, the daemon comes back). Refuses while a session is
                      busy unless --force; --when-idle waits for the other
                      sessions (the calling one does not count) up to --timeout
                      (default 300s, exit 2)

Options:
${serveOptions}
`;
	process.stdout.write(usage);
}

function log(message: string): void {
	const stamp = new Date().toISOString().slice(11, 23);
	process.stderr.write(`${stamp} ${message}\n`);
}

/** Serve flags, reproduced for a detached child and kept in the state file. */
function serveArgs(options: Options): string[] {
	const args = [
		"--host",
		options.host,
		"--port",
		String(options.port),
		"--data-dir",
		options.dataDir,
		"--pi",
		options.piBin,
		"--idle-ms",
		String(options.idleMs),
	];
	if (options.dev) args.push("--dev");
	for (const name of options.allowCommands) args.push("--allow-command", name);
	for (const name of options.denyCommands) args.push("--deny-command", name);
	if (options.noBash) args.push("--no-bash");
	return args;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command: Command = SUBCOMMANDS.has(argv[0] ?? "") ? (argv.shift() as Command) : "serve";
	const options = parseArgs(argv);
	switch (command) {
		case "start":
			return await cmdStart(options);
		case "stop":
			return await cmdStop(options);
		case "status":
			return await cmdStatus(options);
		case "logs":
			return await cmdLogs(options);
		case "refresh":
			return await cmdRefresh(options);
		case "restart":
			return await cmdRestart(options);
		default:
			return await serve(options);
	}
}

// -------------------------------------------------------------------- serve

async function serve(options: Options): Promise<void> {
	const paths = daemonPaths(options.dataDir);
	await mkdir(join(options.dataDir, "sessions"), { recursive: true });

	const existing = await runningDaemon(options.dataDir);
	if (existing && existing.pid !== process.pid) {
		throw new Error(`another pixip is running for ${options.dataDir} (pid ${existing.pid}); stop it first`);
	}

	const hub = new Hub({
		piBin: options.piBin,
		sessionsDir: join(options.dataDir, "sessions"),
		dataDir: options.dataDir,
		indexPath: join(options.dataDir, "sessions.json"),
		idleMs: options.idleMs,
		titleModel: options.titleModel,
		extraPiArgs: [],
		cliCommands: {
			allow: options.allowCommands,
			deny: options.denyCommands,
			bash: !options.noBash,
		},
		log,
	});

	const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client");
	const server = await startServer({
		host: options.host,
		port: options.port,
		hub,
		clientDir,
		log,
		dev: options.dev,
	});

	// The state file is what `status`, `stop`, `refresh` and `restart` read; it
	// records the actual port (so `--port 0` works) and the serve flags.
	await writeDaemonState(options.dataDir, {
		pid: process.pid,
		host: options.host,
		port: Number(new URL(server.url).port),
		url: server.url,
		startedAt: new Date().toISOString(),
		dataDir: options.dataDir,
		args: serveArgs(options),
	});

	log(`pixip listening on ${server.url}`);
	log(`pid ${process.pid}, data dir ${options.dataDir}, log ${paths.log}`);
	if (options.host !== "127.0.0.1" && options.host !== "::1") {
		log(`warning: bound to ${options.host}; this UI has no authentication`);
	}

	const softRefresh = async (label: string) => {
		try {
			const report = await server.refresh();
			log(`${label}: reloaded ${report.reloaded.join(", ")} (${report.reloads} total)`);
		} catch (error) {
			log(`${label} failed: ${(error as Error).message}`);
		}
	};
	process.on("SIGHUP", () => void softRefresh("SIGHUP"));

	let closing = false;
	const shutdown = async (signal: string, restart = false) => {
		if (closing) return;
		closing = true;
		log(`${signal}: shutting down`);
		if (restart) {
			// SIGUSR2 means the helper is replacing this daemon: give live sockets
			// the explicit `restarting` frame, then a moment to flush it before close.
			hub.announceRestart();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await server.close();
		await hub.shutdown();
		await clearDaemonState(options.dataDir);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGUSR2", () => void shutdown("SIGUSR2", true));
}

// --------------------------------------------------------------- lifecycle

async function cmdStart(options: Options): Promise<void> {
	await mkdir(join(options.dataDir, "sessions"), { recursive: true });
	const running = await runningDaemon(options.dataDir);
	if (running) throw new Error(`pixip is already running for ${options.dataDir} (pid ${running.pid})`);
	if (!(await portAvailable(options.host, options.port))) {
		throw new Error(`port ${options.port} is already in use on ${options.host}`);
	}
	const state = await startDaemon({ dataDir: options.dataDir, args: serveArgs(options) });
	process.stdout.write(`pixip listening on ${state.url} (pid ${state.pid})\n`);
}

async function cmdStop(options: Options): Promise<void> {
	// Never let a bash tool inside a session take the service down. A stop from
	// inside pixip is a restart from the caller's point of view: the calling turn
	// ends, the daemon comes back. A shell outside pixip still stops for real.
	if (insidePixip()) {
		const running = await runningDaemon(options.dataDir);
		if (!running) {
			process.stdout.write(`pixip is not running for ${options.dataDir}\n`);
			return;
		}
		process.stderr.write("pixip stop requested from inside a pixip session: restarting instead\n");
		return await cmdRestart({ ...options, force: true });
	}

	const result = await stopDaemon(options.dataDir);
	if (!result.stopped) {
		process.stdout.write(`pixip is not running for ${options.dataDir}\n`);
		return;
	}
	process.stdout.write(`stopped pixip (pid ${result.state?.pid})\n`);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

async function cmdStatus(options: Options): Promise<void> {
	const state = await runningDaemon(options.dataDir);
	if (!state) {
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ running: false, dataDir: options.dataDir })}\n`);
		} else {
			process.stdout.write(`pixip is not running for ${options.dataDir}\n`);
		}
		process.exitCode = 1;
		return;
	}
	const [health, sessions] = await Promise.all([
		fetchHealth(state.url).catch(() => undefined),
		fetchSessions(state.url).catch(() => []),
	]);
	const uptimeMs = Date.now() - Date.parse(state.startedAt);
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({
				running: true,
				pid: state.pid,
				host: state.host,
				port: state.port,
				url: state.url,
				startedAt: state.startedAt,
				uptimeMs: Math.max(0, uptimeMs),
				sessions: sessions.length,
				reloads: health?.reloads ?? null,
			})}\n`,
		);
		return;
	}
	process.stdout.write(
		`pixip running on ${state.url} (pid ${state.pid}, up ${formatDuration(uptimeMs)}, ${sessions.length} session(s), ${health?.reloads ?? 0} reload(s))\n`,
	);
	process.stdout.write(`data dir: ${state.dataDir}\n`);
}

async function cmdLogs(options: Options): Promise<void> {
	const path = daemonPaths(options.dataDir).log;
	process.stdout.write(await readLogTail(options.dataDir, options.lines));
	if (!options.follow) return;

	let offset = await logSize(options.dataDir).catch(() => 0);
	const timer = setInterval(() => {
		void (async () => {
			try {
				const size = await logSize(options.dataDir);
				if (size <= offset) return;
				const handle = await open(path, "r");
				try {
					const buffer = Buffer.alloc(size - offset);
					await handle.read(buffer, 0, buffer.length, offset);
					process.stdout.write(buffer);
					offset = size;
				} finally {
					await handle.close();
				}
			} catch {
				// rotated or removed: keep following until interrupted
			}
		})();
	}, 300);
	await new Promise<void>((resolveFollow) => {
		process.once("SIGINT", () => {
			clearInterval(timer);
			resolveFollow();
		});
	});
}

async function cmdRefresh(options: Options): Promise<void> {
	const report = await refreshDaemon(options.dataDir);
	process.stdout.write(`reloaded ${report.reloaded.join(", ")} (${report.reloads} total)\n`);
}

/**
 * `/fit`-style self-update: a bash tool runs inside a Pi child of the daemon it
 * wants to replace. Stopping the daemon kills that child (and this CLI with it),
 * so the stop/start must happen in a process outside that tree. `PIXIP_SESSION_ID`
 * is inherited by every child of the hub's Pi processes; it identifies the
 * calling session, which is about to end and therefore must not count as busy.
 */
function callerSession(): string | undefined {
	const id = process.env["PIXIP_SESSION_ID"]?.trim();
	return id || undefined;
}

/** Is this CLI running as a child of a pixip-managed Pi session? */
function insidePixip(): boolean {
	return process.env["PIXIP_INSIDE"] === "1" || Boolean(callerSession());
}

function isCaller(session: SessionInfo, caller: string | undefined): boolean {
	if (!caller) return false;
	return session.logicalId === caller || session.id === caller;
}

/** Spawn the detached helper that performs the actual stop/start. */
function spawnRestartHelper(options: Options): void {
	const logFd = openSync(daemonPaths(options.dataDir).log, "a");
	try {
		// Strip the caller marker: the helper is not a session, and the new
		// daemon's own children get a fresh one from the hub anyway.
		const env = { ...process.env };
		delete env["PIXIP_SESSION_ID"];
		const child = spawn(
			process.execPath,
			[fileURLToPath(import.meta.url), "restart", "--detached", "--data-dir", options.dataDir],
			{
				detached: true,
				stdio: ["ignore", logFd, logFd],
				cwd: process.cwd(),
				env,
			},
		);
		child.unref();
	} finally {
		closeSync(logFd);
	}
}

/**
 * Helper body: wait out the old daemon, then start the same serve args. It logs
 * to `<data-dir>/pixip.log`, so a restart from inside a session leaves evidence
 * even though the calling turn is gone.
 */
async function runRestartHelper(options: Options): Promise<void> {
	const note = (message: string) => log(`[restart helper] ${message}`);
	const running = await runningDaemon(options.dataDir);
	const args = running && running.args.length > 0 ? running.args : serveArgs(options);
	if (running) {
		note(`stopping pid ${running.pid}`);
		// SIGUSR2 tells the old daemon this is a restart, so it announces it.
		const stopped = await stopDaemon(options.dataDir, undefined, "SIGUSR2");
		if (!stopped.stopped) {
			note(`pid ${running.pid} did not stop`);
			process.exitCode = 1;
			return;
		}
	}
	const state = await startDaemon({ dataDir: options.dataDir, args });
	note(`listening on ${state.url} (pid ${state.pid})`);
}

async function cmdRestart(options: Options): Promise<void> {
	if (options.detached) return await runRestartHelper(options);

	const running = await runningDaemon(options.dataDir);
	if (!running) {
		// Idempotent: restarting a stopped data dir is just a start.
		await cmdStart(options);
		return;
	}

	const caller = callerSession();
	const busyNow = async () =>
		busySessions(await fetchSessions(running.url).catch(() => [])).filter((session) => !isCaller(session, caller));

	if (options.whenIdle) {
		const deadline = Date.now() + options.timeoutS * 1000;
		for (;;) {
			const busy = await busyNow();
			if (busy.length === 0) break;
			if (Date.now() >= deadline) {
				process.stderr.write(`still busy after ${options.timeoutS}s: ${describeSessions(busy)}\n`);
				process.exitCode = 2;
				return;
			}
			await delay(1000);
		}
	} else if (!options.force) {
		const busy = await busyNow();
		if (busy.length > 0) {
			throw new Error(`refusing to restart while busy: ${describeSessions(busy)}; use --force or --when-idle`);
		}
	}

	// Hand the destructive half to a detached helper. This process may be a child
	// of a Pi child that is about to be stopped, so it must not be the one doing
	// `stopDaemon()`; the helper survives the shutdown and starts the replacement.
	spawnRestartHelper(options);

	// A normal shell waits here and prints the new URL. Inside a session this
	// process is killed when the old daemon stops its child; the helper finishes
	// the job and logs it.
	const deadline = Date.now() + 30_000;
	for (;;) {
		const state = await readDaemonState(options.dataDir).catch(() => undefined);
		if (state && state.pid !== running.pid) {
			const health = await waitForHealth(state.url, 1000, state.pid).catch(() => undefined);
			if (health) {
				process.stdout.write(`pixip restarted on ${state.url} (pid ${state.pid})\n`);
				return;
			}
		}
		if (Date.now() >= deadline) {
			process.stderr.write(`restart helper did not bring pixip back; see ${daemonPaths(options.dataDir).log}\n`);
			process.exitCode = 1;
			return;
		}
		await delay(100);
	}
}

main().catch((error: unknown) => {
	log(`fatal: ${(error as Error).message}`);
	process.exit(1);
});

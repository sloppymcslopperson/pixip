#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hub } from "../src/hub.ts";
import type { RemoveWorktreeResult, WorktreeListing } from "../src/hub.ts";
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
import { detectRepo, pruneWorktrees, realCwd } from "../src/worktree.ts";
import type { WorktreeEntry } from "../src/worktree.ts";
import type { SessionInfo } from "../src/wire.ts";
import { INBOX_PURPOSES, type InboxList, type InboxView } from "../src/inbox.ts";
import { spawnEnv } from "../src/spawnEnv.ts";

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

type Command =
	"serve" | "start" | "stop" | "status" | "logs" | "refresh" | "restart" | "worktree" | "protect" | "inbox";

const SUBCOMMANDS = new Set<string>([
	"start",
	"stop",
	"status",
	"logs",
	"refresh",
	"restart",
	"worktree",
	"protect",
	"inbox",
]);

interface Options {
	host: string;
	port: number;
	dataDir: string;
	piBin: string;
	/** `--pi-host [path]` / `PIXIP_PI_HOST`; `""` means resolve the installed host bin. */
	piHost?: string;
	idleMs: number;
	/** Blocking UI timeout with no browser attached; 0 disables. */
	pendingUiTimeoutMs: number;
	/** Blocking UI timeout with a browser attached; 0 disables. */
	pendingUiOpenTimeoutMs: number;
	/** How long the "more time?" card waits; 0 disables. */
	pendingUiMoreTimeMs: number;
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
	/** `protect --off`: clear the flag instead of setting it. */
	off: boolean;
	/** `restart --when-idle` */
	whenIdle: boolean;
	/** `restart --timeout <seconds>` */
	timeoutS: number;
	/** Maximum retained inbox messages. */
	inboxLimit: number;
	/** Bearer token guarding the inbox API; empty means auth is off. */
	inboxToken: string;
	/** `inbox send --subject` */
	subject: string;
	/** `inbox send --purpose` */
	purpose: string;
	/** `inbox send --quiet` */
	quiet: boolean;
	/** `inbox list --unread` */
	unread: boolean;
	/** `inbox list --archived` */
	archived: boolean;
	/** Internal: this process is the detached restart helper. */
	detached: boolean;
	/** Non-flag arguments after the subcommand (`worktree list [<path>]`). */
	positionals: string[];
}

interface WorktreeSessionView {
	id: string;
	name: string;
	state: SessionInfo["state"];
	live: boolean;
}

interface WorktreeView extends WorktreeEntry {
	owner: "pixip" | "external";
	liveAgents: number;
	sessions: WorktreeSessionView[];
}

interface WorktreeListingResult extends WorktreeListing {
	sessions: SessionInfo[];
	source: "daemon" | "offline";
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		host: "127.0.0.1",
		port: 8137,
		dataDir: resolve(process.env["PIXIP_DATA_DIR"] ?? "tmp/dev"),
		piBin: "pi",
		piHost: undefined,
		idleMs: 15 * 60_000,
		pendingUiTimeoutMs: 5 * 60 * 60_000,
		pendingUiOpenTimeoutMs: 10 * 60 * 60_000,
		pendingUiMoreTimeMs: 2 * 60_000,
		titleModel: process.env["PIXIP_TITLE_MODEL"] ?? "",
		dev: false,
		allowCommands: [],
		denyCommands: [],
		noBash: false,
		json: false,
		follow: false,
		lines: 200,
		force: false,
		off: false,
		whenIdle: false,
		timeoutS: 300,
		inboxLimit: 200,
		inboxToken: process.env["PIXIP_INBOX_TOKEN"] ?? "",
		subject: "",
		purpose: "attention-needed",
		quiet: false,
		unread: false,
		archived: false,
		detached: false,
		positionals: [],
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg !== undefined && arg.startsWith("--pi-host=")) {
			options.piHost = arg.slice("--pi-host=".length);
			continue;
		}
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
			case "--pi-host": {
				// The value is optional: a bare flag means "resolve the installed host".
				const value = argv[index + 1];
				if (value !== undefined && !value.startsWith("-")) {
					options.piHost = value;
					index += 1;
				} else {
					options.piHost = "";
				}
				break;
			}
			case "--idle-ms":
				options.idleMs = Number(next());
				break;
			case "--pending-ui-timeout-ms":
				options.pendingUiTimeoutMs = Number(next());
				break;
			case "--pending-ui-open-timeout-ms":
				options.pendingUiOpenTimeoutMs = Number(next());
				break;
			case "--pending-ui-more-time-ms":
				options.pendingUiMoreTimeMs = Number(next());
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
			case "--off":
				options.off = true;
				break;
			case "--when-idle":
				options.whenIdle = true;
				break;
			case "--timeout":
				options.timeoutS = Number(next());
				break;
			case "--inbox-limit":
				options.inboxLimit = Number(next());
				break;
			case "--inbox-token":
				options.inboxToken = next();
				break;
			case "--subject":
				options.subject = next();
				break;
			case "--purpose":
				options.purpose = next();
				break;
			case "--quiet":
				options.quiet = true;
				break;
			case "--unread":
				options.unread = true;
				break;
			case "--archived":
				options.archived = true;
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
				if (arg === undefined) break;
				if (arg.startsWith("-")) throw new Error(`unknown argument ${arg}`);
				options.positionals.push(arg);
				break;
		}
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new Error("--port must be an integer between 0 and 65535");
	}
	if (!Number.isFinite(options.idleMs) || options.idleMs < 0) throw new Error("--idle-ms must be 0 or more");
	if (!Number.isFinite(options.pendingUiTimeoutMs) || options.pendingUiTimeoutMs < 0) {
		throw new Error("--pending-ui-timeout-ms must be 0 or more");
	}
	if (!Number.isFinite(options.pendingUiOpenTimeoutMs) || options.pendingUiOpenTimeoutMs < 0) {
		throw new Error("--pending-ui-open-timeout-ms must be 0 or more");
	}
	if (!Number.isFinite(options.pendingUiMoreTimeMs) || options.pendingUiMoreTimeMs < 0) {
		throw new Error("--pending-ui-more-time-ms must be 0 or more");
	}
	if (!Number.isInteger(options.lines) || options.lines < 1) throw new Error("--lines must be 1 or more");
	if (!Number.isFinite(options.timeoutS) || options.timeoutS < 0) throw new Error("--timeout must be 0 or more");
	if (!Number.isInteger(options.inboxLimit) || options.inboxLimit < 1) {
		throw new Error("--inbox-limit must be an integer of 1 or more");
	}
	if (options.piHost === undefined && process.env["PIXIP_PI_HOST"]) {
		options.piHost = process.env["PIXIP_PI_HOST"];
	}
	return options;
}

function printHelp(): void {
	const serveOptions = `  --host <address>    bind address (default 127.0.0.1)
  --port <number>     port (default 8137)
  --data-dir <path>   isolation root; sessions, pixip.pid, pixip.state.json
                      and pixip.log live here (default ./tmp/dev), never
                      ~/.agent/sessions
  --pi <path>         pi executable (default: pi from PATH)
  --pi-host [path]    spawn pixip-pi-host instead of pi; no value resolves the
                      installed workspace bin, a value overrides it
                      (env: PIXIP_PI_HOST). Legacy --pi stays the default.
  --idle-ms <ms>      detach an idle session after this long, keeping its JSONL
                      for resume (default 900000; 0 disables)
  --pending-ui-timeout-ms <ms>
                      expire a blocking question with no browser attached
                      (default 18000000 = 5h; 0 disables)
  --pending-ui-open-timeout-ms <ms>
                      expire a blocking question while a browser is attached
                      (default 36000000 = 10h; 0 disables)
  --pending-ui-more-time-ms <ms>
                      how long the "more time?" card waits for an answer
                      (default 120000 = 2m; 0 disables)
  --title-model <p/id> model for the automatic 3-5 word session label
                      (default: the session's current model; env: PIXIP_TITLE_MODEL)
  --dev               re-read client assets per request (no restart on CSS/JS edits)
  --inbox-limit <n>   maximum retained inbox messages (default 200; archived
                      then read messages are evicted first)
  --inbox-token <t>   require Authorization: Bearer <t> on the inbox API and
                      pass PIXIP_INBOX_TOKEN to Pi children (default: off;
                      env: PIXIP_INBOX_TOKEN)
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
  protect [<session-id>] [--off] [--json]
                      mark one session as protected from the dashboard bulk
                      archive (or clear it with --off). Defaults to the caller's
                      PIXIP_SESSION_ID, so an agent can protect its own session.
                      The flag is stored in the session index and survives
                      restarts and archive/restore; manual archive still works
  worktree <list|remove|prune>
                      inspect or remove git worktrees (see 'pixip worktree --help')
  inbox <send|list|read|archive|delete>
                      durable messages from agents, readable in the dashboard
                      (see 'pixip inbox --help')

Options:
${serveOptions}
`;
	process.stdout.write(usage);
}

function printInboxHelp(): void {
	const usage = `Usage: pixip inbox <command> [options]

Commands:
  send --subject <text> [--purpose <purpose>] [--quiet] <body>
                      post one message. Purpose is attention-needed (default),
                      deliverable, extra-info or no-rush. Inside a pixip session
                      the sender is the calling session (PIXIP_SESSION_ID);
                      otherwise it is labelled "local shell"
  list [--unread] [--archived] [--json]
                      newest first; archived messages are hidden by default
  read <id|all>       mark one message read, or every unread message
  archive <id>        hide a message; restore it from the dashboard
  delete <id>         remove a message permanently

The command talks to the daemon at PIXIP_DAEMON_URL when set, otherwise to
the running daemon for --data-dir. It never edits <data-dir>/inbox.json.

Options:
  --data-dir <path>   isolation root used to find the running daemon
                      (default ./tmp/dev)
  --json              machine-readable output for list
`;
	process.stdout.write(usage);
}

function printWorktreeHelp(): void {
	const usage = `Usage: pixip worktree <command> [options]

Commands:
  list [<path>] [--json]
                      trees in the repository containing <path> (default: cwd),
                      with owner, live agents, dirty state and session names
  remove <path> [--force]
                      remove one exact worktree root. --force discards
                      uncommitted changes; referenced and external trees are
                      always refused (exit 2)
  prune [<path>]      run git worktree prune for the repository containing
                      <path> (default: cwd)

Options:
  --data-dir <path>   isolation root used by a running daemon, or read offline
                      when no daemon is running (default ./tmp/dev)
  --json              machine-readable output
  --force             allow removing a dirty worktree
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
		"--pending-ui-timeout-ms",
		String(options.pendingUiTimeoutMs),
		"--pending-ui-open-timeout-ms",
		String(options.pendingUiOpenTimeoutMs),
		"--pending-ui-more-time-ms",
		String(options.pendingUiMoreTimeMs),
		"--inbox-limit",
		String(options.inboxLimit),
	];
	if (options.inboxToken) args.push("--inbox-token", options.inboxToken);
	if (options.piHost !== undefined) {
		args.push("--pi-host");
		if (options.piHost) args.push(options.piHost);
	}
	if (options.dev) args.push("--dev");
	for (const name of options.allowCommands) args.push("--allow-command", name);
	for (const name of options.denyCommands) args.push("--deny-command", name);
	if (options.noBash) args.push("--no-bash");
	return args;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command: Command = SUBCOMMANDS.has(argv[0] ?? "") ? (argv.shift() as Command) : "serve";
	if (command === "worktree") {
		const action = argv.shift();
		if (!action || action === "--help" || action === "-h" || action === "help") {
			printWorktreeHelp();
			return;
		}
		const options = parseArgs(argv);
		return await cmdWorktree(action, options);
	}
	if (command === "inbox") {
		const action = argv.shift();
		if (!action || action === "--help" || action === "-h" || action === "help") {
			printInboxHelp();
			return;
		}
		const options = parseArgs(argv);
		return await cmdInbox(action, options);
	}
	const options = parseArgs(argv);
	if (options.positionals.length > 0 && command !== "protect") {
		throw new Error(`unknown argument ${options.positionals[0]}`);
	}
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
		case "protect":
			return await cmdProtect(options);
		default:
			return await serve(options);
	}
}

// -------------------------------------------------------------------- serve

/** Resolve an explicit host bin or the installed `pixip-pi-host` package bin. */
function resolvePiHost(value: string | undefined): string {
	if (value) {
		const path = resolve(value);
		if (!existsSync(path)) throw new Error(`--pi-host not found: ${path}`);
		return path;
	}
	const require = createRequire(import.meta.url);
	let packagePath: string;
	try {
		packagePath = require.resolve("pixip-pi-host/package.json");
	} catch {
		throw new Error("pixip-pi-host is not installed; pass --pi-host <path> or install the workspace");
	}
	const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
		bin?: string | Record<string, string>;
	};
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pixip-pi-host"];
	if (!bin) throw new Error(`pixip-pi-host has no bin in ${packagePath}`);
	const path = resolve(dirname(packagePath), bin);
	if (!existsSync(path)) throw new Error(`pixip-pi-host bin not found: ${path}`);
	return path;
}

async function serve(options: Options): Promise<void> {
	const paths = daemonPaths(options.dataDir);
	const piHostBin = options.piHost === undefined ? undefined : resolvePiHost(options.piHost || undefined);
	await mkdir(join(options.dataDir, "sessions"), { recursive: true });

	const existing = await runningDaemon(options.dataDir);
	if (existing && existing.pid !== process.pid) {
		throw new Error(`another pixip is running for ${options.dataDir} (pid ${existing.pid}); stop it first`);
	}

	const hub = new Hub({
		piBin: options.piBin,
		piHostBin,
		sessionsDir: join(options.dataDir, "sessions"),
		dataDir: options.dataDir,
		indexPath: join(options.dataDir, "sessions.json"),
		idleMs: options.idleMs,
		pendingUiGraceMs: options.pendingUiTimeoutMs,
		pendingUiOpenTimeoutMs: options.pendingUiOpenTimeoutMs,
		pendingUiMoreTimeMs: options.pendingUiMoreTimeMs,
		titleModel: options.titleModel,
		inboxLimit: options.inboxLimit,
		...(options.inboxToken ? { inboxToken: options.inboxToken } : {}),
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
	hub.setDaemonUrl(server.url);

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
 * Protect a session from the dashboard bulk archive. With no id, the caller's
 * `PIXIP_SESSION_ID` is used, which is how a Pi child marks its own session.
 */
async function cmdProtect(options: Options): Promise<void> {
	const id = options.positionals[0] ?? callerSession();
	if (!id) {
		throw new Error("protect needs a session id, or PIXIP_SESSION_ID when run inside a pixip session");
	}
	const value = !options.off;
	const daemon = await runningDaemon(options.dataDir);
	let info: SessionInfo & { protected?: boolean };
	if (daemon) {
		const result = await fetchJson<{ session: SessionInfo }>(
			new URL(`api/sessions/${encodeURIComponent(id)}/protect`, daemon.url),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ protected: value }),
			},
		);
		info = result.session;
	} else {
		const hub = offlineHub(options);
		try {
			info = await hub.setProtected(id, value);
		} finally {
			await hub.shutdown();
		}
	}
	const label = info.name || info.logicalId || id;
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, protected: value, session: info })}\n`);
		return;
	}
	process.stdout.write(`${value ? "protected" : "unprotected"} ${label}\n`);
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
		// daemon's own children get a fresh one from the hub anyway. `spawnEnv`
		// also drops the caller's Pi session identity, so the restarted daemon
		// does not hand it to every later child.
		const env = spawnEnv();
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

// ------------------------------------------------------------------ inbox

interface InboxTarget {
	url: string;
	token?: string;
}

async function inboxTarget(options: Options): Promise<InboxTarget> {
	const fromEnv = process.env["PIXIP_DAEMON_URL"]?.trim();
	if (fromEnv)
		return {
			url: fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`,
			token: process.env["PIXIP_INBOX_TOKEN"] || undefined,
		};
	const state = await runningDaemon(options.dataDir);
	if (!state) {
		throw new Error(`pixip is not running for ${options.dataDir}; start it with \`pixip start\``);
	}
	return { url: state.url, token: process.env["PIXIP_INBOX_TOKEN"] || undefined };
}

async function inboxRequest<T>(options: Options, path: string, init: RequestInit = {}): Promise<T> {
	const target = await inboxTarget(options);
	const headers = new Headers(init.headers);
	if (target.token) headers.set("authorization", `Bearer ${target.token}`);
	let response: Response;
	try {
		response = await fetch(new URL(path, target.url), { ...init, headers, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		throw new Error(`cannot reach pixip at ${target.url}: ${(error as Error).message}`);
	}
	const text = await response.text();
	let body: unknown = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		const message = (body as { error?: unknown }).error;
		throw new Error(typeof message === "string" ? message : `request failed (${response.status})`);
	}
	return body as T;
}

async function inboxMessages(options: Options, includeArchived = true): Promise<InboxList> {
	const query = includeArchived ? "?all=1&filter=all" : "?filter=all";
	return await inboxRequest<InboxList>(options, `api/inbox${query}`);
}

/** Users copy the short ids the list prints, so resolve a unique prefix locally. */
async function resolveInboxId(options: Options, target: string): Promise<string> {
	const list = await inboxMessages(options, true);
	if (list.messages.some((message) => message.id === target)) return target;
	const matches = list.messages.filter((message) => message.id.startsWith(target));
	if (matches.length === 1 && matches[0]) return matches[0].id;
	if (matches.length > 1) throw new Error(`ambiguous inbox id ${target}`);
	throw new Error(`unknown inbox message ${target}`);
}

function formatInboxTable(messages: InboxView[]): string {
	const headers = ["ID", "PURPOSE", "FROM", "STATUS", "WHEN", "SUBJECT"];
	const data = messages.map((message) => [
		message.id.slice(0, 8),
		message.purpose,
		message.sender.name,
		message.senderStatus,
		message.createdAt.slice(0, 16).replace("T", " "),
		`${message.readAt ? "" : "● "}${message.subject}${message.archivedAt ? " (archived)" : ""}`,
	]);
	const widths = headers.map((header, index) => Math.max(header.length, ...data.map((row) => row[index]?.length ?? 0)));
	const line = (cells: string[]) =>
		cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  ");
	return [line(headers), line(widths.map((width) => "-".repeat(width))), ...data.map(line)].join("\n") + "\n";
}

async function cmdInboxSend(options: Options): Promise<void> {
	const body = options.positionals.join(" ").trim();
	if (!options.subject.trim() || !body) {
		throw new Error("usage: pixip inbox send --subject <text> [--purpose <purpose>] <body>");
	}
	if (!(INBOX_PURPOSES as readonly string[]).includes(options.purpose)) {
		throw new Error(`--purpose must be one of ${INBOX_PURPOSES.join(", ")}`);
	}
	const result = await inboxRequest<{ message: InboxView }>(options, "api/inbox", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			subject: options.subject,
			body,
			purpose: options.purpose,
			...(callerSession() ? { sessionId: callerSession() } : {}),
		}),
	});
	if (!options.quiet) {
		process.stdout.write(
			`sent ${result.message.id.slice(0, 8)} · ${result.message.purpose} · ${result.message.subject}\n`,
		);
	}
}

async function cmdInboxList(options: Options): Promise<void> {
	if (options.positionals.length > 0) throw new Error("usage: pixip inbox list [--unread] [--archived] [--json]");
	const params = new URLSearchParams({ filter: options.unread ? "unread" : "all" });
	if (options.archived) params.set("archived", "1");
	const list = await inboxRequest<InboxList>(options, `api/inbox?${params.toString()}`);
	if (options.json) {
		process.stdout.write(`${JSON.stringify(list)}\n`);
		return;
	}
	process.stdout.write(list.messages.length > 0 ? formatInboxTable(list.messages) : "inbox is empty\n");
}

async function cmdInboxRead(options: Options): Promise<void> {
	if (options.positionals.length !== 1) throw new Error("usage: pixip inbox read <id|all>");
	const target = options.positionals[0] as string;
	if (target === "all") {
		const result = await inboxRequest<{ read: number }>(options, "api/inbox/read-all", { method: "POST" });
		process.stdout.write(`marked ${result.read} message(s) read\n`);
		return;
	}
	const id = await resolveInboxId(options, target);
	const result = await inboxRequest<{ read: number }>(options, `api/inbox/${encodeURIComponent(id)}/read`, {
		method: "POST",
	});
	process.stdout.write(result.read > 0 ? `marked ${id.slice(0, 8)} read\n` : `${id.slice(0, 8)} was already read\n`);
}

async function cmdInboxArchive(options: Options): Promise<void> {
	if (options.positionals.length !== 1) throw new Error("usage: pixip inbox archive <id>");
	const id = await resolveInboxId(options, options.positionals[0] as string);
	await inboxRequest(options, `api/inbox/${encodeURIComponent(id)}/archive`, { method: "POST" });
	process.stdout.write(`archived ${id.slice(0, 8)}\n`);
}

async function cmdInboxDelete(options: Options): Promise<void> {
	if (options.positionals.length !== 1) throw new Error("usage: pixip inbox delete <id>");
	const id = await resolveInboxId(options, options.positionals[0] as string);
	await inboxRequest(options, `api/inbox/${encodeURIComponent(id)}`, { method: "DELETE" });
	process.stdout.write(`deleted ${id.slice(0, 8)}\n`);
}

async function cmdInbox(action: string, options: Options): Promise<void> {
	switch (action) {
		case "send":
			return await cmdInboxSend(options);
		case "list":
			return await cmdInboxList(options);
		case "read":
			return await cmdInboxRead(options);
		case "archive":
			return await cmdInboxArchive(options);
		case "delete":
			return await cmdInboxDelete(options);
		default:
			throw new Error(`unknown inbox command ${action}`);
	}
}

// --------------------------------------------------------------- worktree

function isLiveSession(session: SessionInfo): boolean {
	return session.state === "starting" || session.state === "idle" || session.state === "busy";
}

function enrichWorktrees(worktrees: WorktreeEntry[], repo: string, sessions: SessionInfo[]): WorktreeView[] {
	return worktrees.map((entry) => {
		const matching = sessions.filter((session) =>
			entry.path === repo ? session.repo === repo && !session.worktree : session.worktree?.path === entry.path,
		);
		const rows = matching.map((session) => ({
			id: session.logicalId ?? session.id,
			name: session.name || "Untitled session",
			state: session.state,
			live: isLiveSession(session),
		}));
		return {
			...entry,
			owner: entry.pixipActive ? "pixip" : "external",
			liveAgents: rows.filter((row) => row.live).length,
			sessions: rows,
		};
	});
}

function offlineHub(options: Options): Hub {
	return new Hub({
		piBin: options.piBin,
		sessionsDir: join(options.dataDir, "sessions"),
		dataDir: options.dataDir,
		indexPath: join(options.dataDir, "sessions.json"),
		idleMs: 0,
		extraPiArgs: [],
		// A read-only CLI command must not purge the daemon's trash as a side effect.
		skipStartupTrash: true,
		log: () => {},
	});
}

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
	const text = await response.text();
	let body: unknown = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		const error = (body as { error?: unknown }).error;
		throw new Error(typeof error === "string" ? error : `request failed (${response.status})`);
	}
	return body as T;
}

async function loadWorktreeListing(options: Options, cwd: string): Promise<WorktreeListingResult> {
	const daemon = await runningDaemon(options.dataDir);
	if (daemon) {
		const [listing, sessions] = await Promise.all([
			fetchJson<WorktreeListing>(new URL(`api/worktrees?cwd=${encodeURIComponent(cwd)}`, daemon.url)),
			fetchSessions(daemon.url),
		]);
		return { ...listing, sessions, source: "daemon" };
	}

	const hub = offlineHub(options);
	try {
		const [listing, sessions] = await Promise.all([hub.listWorktrees(cwd), hub.list()]);
		return { ...listing, sessions, source: "offline" };
	} finally {
		await hub.shutdown();
	}
}

async function findWorktree(entries: WorktreeEntry[], target: string): Promise<WorktreeEntry | undefined> {
	const realTarget = await realCwd(target);
	for (const entry of entries) {
		if ((await realCwd(entry.path)) === realTarget) return entry;
	}
	return entries.find((entry) => resolve(entry.path) === resolve(target));
}

function formatWorktreeTable(rows: WorktreeView[]): string {
	const headers = ["PATH", "BRANCH", "OWNER", "LIVE", "DIRTY", "SESSIONS"];
	const data = rows.map((entry) => [
		entry.path,
		entry.branch,
		entry.owner,
		String(entry.liveAgents),
		entry.dirty ? `${entry.changedFiles} changed` : "clean",
		entry.sessions.length > 0 ? entry.sessions.map((session) => `${session.name} (${session.state})`).join(", ") : "-",
	]);
	const widths = headers.map((header, index) => Math.max(header.length, ...data.map((row) => row[index]?.length ?? 0)));
	const line = (cells: string[]) =>
		cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  ");
	return [line(headers), line(widths.map((width) => "-".repeat(width))), ...data.map(line)].join("\n") + "\n";
}

async function cmdWorktreeList(options: Options): Promise<void> {
	if (options.positionals.length > 1) {
		throw new Error("usage: pixip worktree list [<repo-or-path>] [--json]");
	}
	const cwd = resolve(options.positionals[0] ?? process.cwd());
	const listing = await loadWorktreeListing(options, cwd);
	const worktrees = enrichWorktrees(listing.worktrees, listing.repo, listing.sessions);
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ repo: listing.repo, worktrees })}\n`);
		return;
	}
	process.stdout.write(`repo: ${listing.repo}\n`);
	process.stdout.write(formatWorktreeTable(worktrees));
}

async function removeViaDaemon(
	url: string,
	cwd: string,
	branch: string,
	force: boolean,
): Promise<RemoveWorktreeResult> {
	const response = await fetch(new URL("api/worktrees", url), {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd, worktree: { branch }, force }),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		body = {};
	}
	if (response.ok) return { removed: true, worktree: body["worktree"] as WorktreeEntry };
	const reason = body["reason"];
	const worktree = body["worktree"] as WorktreeEntry | undefined;
	if (response.status === 409 && worktree && reason === "referenced") {
		return {
			removed: false,
			reason,
			worktree,
			sessions: Array.isArray(body["sessions"]) ? (body["sessions"] as SessionInfo[]) : [],
		};
	}
	if (response.status === 409 && worktree && (reason === "dirty" || reason === "external")) {
		return { removed: false, reason, worktree };
	}
	const error = body["error"];
	throw new Error(typeof error === "string" ? error : `remove failed (${response.status})`);
}

function reportRemoval(result: RemoveWorktreeResult, options: Options): void {
	if (result.removed) {
		if (options.json) {
			process.stdout.write(`${JSON.stringify(result)}\n`);
		} else {
			process.stdout.write(`removed ${result.worktree.path} (${result.worktree.branch})\n`);
		}
		return;
	}

	if (options.json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else if (result.reason === "referenced") {
		process.stderr.write(
			`refusing to remove ${result.worktree.path}: ${result.sessions.length} session(s) still reference it\n`,
		);
		for (const session of result.sessions) {
			process.stderr.write(`  ${session.name || "Untitled session"} (${session.state})\n`);
		}
	} else if (result.reason === "dirty") {
		process.stderr.write(
			`refusing to remove ${result.worktree.path}: ${result.worktree.changedFiles} changed file(s); use --force\n`,
		);
	} else {
		process.stderr.write(`refusing to remove ${result.worktree.path}: external worktree; pixip will not remove it\n`);
	}
	process.exitCode = 2;
}

async function cmdWorktreeRemove(options: Options): Promise<void> {
	if (options.positionals.length !== 1) {
		throw new Error("usage: pixip worktree remove <path> [--force]");
	}
	const target = resolve(options.positionals[0] as string);
	const daemon = await runningDaemon(options.dataDir);

	if (daemon) {
		const listing = await fetchJson<WorktreeListing>(
			new URL(`api/worktrees?cwd=${encodeURIComponent(target)}`, daemon.url),
		);
		const entry = await findWorktree(listing.worktrees, target);
		if (!entry) throw new Error(`unknown worktree ${target}`);
		const result = await removeViaDaemon(daemon.url, listing.repo, entry.branch, options.force);
		return reportRemoval(result, options);
	}

	const hub = offlineHub(options);
	try {
		const listing = await hub.listWorktrees(target);
		const entry = await findWorktree(listing.worktrees, target);
		if (!entry) throw new Error(`unknown worktree ${target}`);
		const result = await hub.removeWorktree({
			cwd: listing.repo,
			worktree: { branch: entry.branch },
			force: options.force,
		});
		reportRemoval(result, options);
	} finally {
		await hub.shutdown();
	}
}

async function cmdWorktreePrune(options: Options): Promise<void> {
	if (options.positionals.length > 1) {
		throw new Error("usage: pixip worktree prune [<repo-or-path>] [--json]");
	}
	const cwd = resolve(options.positionals[0] ?? process.cwd());
	const repo = await detectRepo(cwd);
	if (!repo) throw new Error(`not a git repository: ${cwd}`);
	await pruneWorktrees(repo);
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ pruned: repo })}\n`);
	} else {
		process.stdout.write(`pruned ${repo}\n`);
	}
}

async function cmdWorktree(action: string, options: Options): Promise<void> {
	switch (action) {
		case "list":
			return await cmdWorktreeList(options);
		case "remove":
			return await cmdWorktreeRemove(options);
		case "prune":
			return await cmdWorktreePrune(options);
		default:
			throw new Error(`unknown worktree command ${action}`);
	}
}

main().catch((error: unknown) => {
	log(`fatal: ${(error as Error).message}`);
	process.exit(1);
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Hub } from "../src/hub.ts";
import type { RemoveWorktreeResult, WorktreeListing } from "../src/hub.ts";
import type { RunningServer } from "../src/server.ts";
import type { WatchHandle } from "../src/reload/watch.ts";
import type { PauseTarget } from "../src/reload/pause.ts";
import type { ReloadReport } from "../src/reload.ts";
import {
	busySessions,
	clearDaemonState,
	daemonPaths,
	delay,
	describeSessions,
	fetchHealth,
	fetchSessions,
	logSize,
	liveSessionIds,
	portAvailable,
	readDaemonState,
	readLogTail,
	refreshDaemon,
	runningDaemon,
	startDaemon,
	stopDaemon,
	takeResumeSet,
	waitForHealth,
	writeDaemonState,
	writeReloadResult,
	writeResumeSet,
} from "../src/daemon.ts";
import type { WorktreeEntry } from "../src/worktree.ts";
import { frameNotice, type SessionInfo } from "../src/wire.ts";
import type { InboxList, InboxView } from "../src/inbox.ts";
import { RefResolutionError, formatRef, parseRefArg, resolveRef } from "../src/refResolve.ts";
import { spawnEnv } from "../src/spawnEnv.ts";

// Install the generation-aware resolve hook before the serve path imports any
// reloadable module. CLI-only imports (daemon, worktree, inbox) stay shared.

/**
 * pixip — supervisor + web UI for Pi sessions.
 *
 * `--data-dir` is the isolation boundary used for testing: Pi runs with
 * `--session-dir <data-dir>/sessions`, so the prototype never touches the real
 * `~/.agent/sessions`. The daemon's pid, state and log also live there, so two
 * instances on different `--port`/`--data-dir` never collide.
 *
 * Bare `pixip` and `pixip run` serve in the foreground. `daemon` detaches the
 * same serve path; `stop`/`status`/`logs`/`refresh`/`restart` manage it.
 */

type Command =
	| "run"
	| "daemon"
	| "stop"
	| "status"
	| "logs"
	| "refresh"
	| "reload"
	| "restart"
	| "worktree"
	| "protect"
	| "inbox"
	| "ref";

const SUBCOMMANDS = new Set<string>([
	"run",
	"daemon",
	"stop",
	"status",
	"logs",
	"refresh",
	"reload",
	"restart",
	"worktree",
	"protect",
	"inbox",
	"ref",
]);

interface Options {
	host: string;
	port: number;
	dataDir: string;
	piBin: string;
	/** `--use-system-pi`: spawn the legacy `pi --mode rpc` backend. */
	useSystemPi: boolean;
	/** `PIXIP_PI_HOST`: host executable path; undefined resolves the installed bin. */
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
	/** `--watch`: reload after a debounced change in src/ or extensions/. */
	watch: boolean;
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
		useSystemPi: false,
		piHost: undefined,
		idleMs: 15 * 60_000,
		pendingUiTimeoutMs: 5 * 60 * 60_000,
		pendingUiOpenTimeoutMs: 10 * 60 * 60_000,
		pendingUiMoreTimeMs: 2 * 60_000,
		titleModel: process.env["PIXIP_TITLE_MODEL"] ?? "",
		dev: true,
		watch: false,
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
	let piFlag: string | undefined;
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
				piFlag = next();
				options.piBin = piFlag;
				break;
			case "--use-system-pi":
				options.useSystemPi = true;
				break;
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
			case "--serious-mode":
				options.dev = false;
				break;
			case "--watch":
				options.watch = true;
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
	const piEnv = process.env["PIXIP_PI"]?.trim() || undefined;
	const hostEnv = process.env["PIXIP_PI_HOST"]?.trim() || undefined;
	if (!options.useSystemPi) {
		if (piFlag !== undefined || piEnv !== undefined) {
			throw new Error("--pi and PIXIP_PI require --use-system-pi");
		}
		options.piHost = hostEnv;
		return options;
	}

	// System mode never uses the host override. An explicit path beats the
	// literal default `pi`; when both are explicit, the flag wins.
	options.piHost = undefined;
	const flagIsDefault = piFlag === undefined || piFlag === "pi";
	const envIsDefault = piEnv === undefined || piEnv === "pi";
	if (piFlag !== undefined && piEnv !== undefined) {
		options.piBin = flagIsDefault && !envIsDefault ? piEnv : piFlag;
	} else if (piFlag !== undefined) {
		options.piBin = piFlag;
	} else if (piEnv !== undefined) {
		options.piBin = piEnv;
	} else {
		throw new Error("--use-system-pi needs --pi <path> or PIXIP_PI");
	}
	return options;
}

function printHelp(): void {
	const serveOptions = `  --host <address>    bind address (default 127.0.0.1)
  --port <number>     port (default 8137)
  --data-dir <path>   isolation root; sessions, pixip.pid, pixip.state.json
                      and pixip.log live here (default ./tmp/dev), never
                      ~/.agent/sessions
  --use-system-pi     spawn the legacy pi --mode rpc backend instead of
                      pixip-pi-host; requires --pi or PIXIP_PI
  --pi <path>         system Pi executable (only with --use-system-pi;
                      default: PIXIP_PI, then required)
                      Host binary override: PIXIP_PI_HOST (unset resolves the
                      installed pixip-pi-host workspace bin)
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
  --serious-mode      host pixip as a stable service: serve client assets from
                      the startup snapshot and disable the dev panel fixture.
                      Dev mode (per-request asset reads) is the default
  --watch             after a 200 ms debounce, reload when src/ or extensions/
                      changes; busy sessions defer instead of interrupting.
                      Off by default (an explicit /reload is the default trigger)
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
  (none)|run          serve in the foreground (default)
  daemon              detach a daemon, write the pid/state, print the URL
  stop                SIGTERM the daemon and clean its pid file. From inside a
                      pixip session this refuses (exit 2) with a user-only
                      message; use /pixup-restart from the browser to replace
                      the daemon
  status [--json]     pid, URL, uptime and session count; non-zero when down
  logs [-f] [--lines] tail <data-dir>/pixip.log (-f follows)
  refresh             soft reload: assets, command policy, session index and the
                      catalog; live children and sockets stay up
  reload              daemon-wide in-place reload: refuse while any session is
                      busy, then re-read assets/policy and reload every live
                      child. Writes <data-dir>/pixip.reload.json (exit 1 when
                      refused, exit 2 from inside an agent)
  restart [--force] [--when-idle] [--timeout <s>]
                      replace the process; sessions survive in their JSONL and
                      the new daemon reattaches the ones that were live. The
                      stop/start runs in a detached helper, so this also works
                      when issued from inside a pixip session (that turn ends,
                      the daemon comes back). Refuses while a session is busy
                      unless --force; --when-idle waits for the other sessions
                      (the calling one does not count) up to --timeout (default
                      300s, exit 2)
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
  ref <tag> [--json]  resolve a copied pixip ref offline: kind, session, role,
                      time, cwd, branch and its text (capped at 4 KB)

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
	if (options.useSystemPi) args.push("--use-system-pi", "--pi", options.piBin);
	if (!options.dev) args.push("--serious-mode");
	if (options.watch) args.push("--watch");
	for (const name of options.allowCommands) args.push("--allow-command", name);
	for (const name of options.denyCommands) args.push("--deny-command", name);
	if (options.noBash) args.push("--no-bash");
	return args;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const first = argv[0];
	let command: Command = "run";
	if (first !== undefined && !first.startsWith("-")) {
		if (!SUBCOMMANDS.has(first)) throw new Error(`unknown command ${first}`);
		command = argv.shift() as Command;
	}
	if (command === "worktree") {
		const action = argv.shift();
		if (!action || action === "--help" || action === "-h" || action === "help") {
			printWorktreeHelp();
			return;
		}
		const options = parseArgs(argv);
		return await cmdWorktree(action, options);
	}
	if (command === "ref") {
		const options = parseArgs(argv);
		return await cmdRef(options);
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
		case "daemon":
			return await cmdDaemon(options);
		case "stop":
			return await cmdStop(options);
		case "status":
			return await cmdStatus(options);
		case "logs":
			return await cmdLogs(options);
		case "refresh":
			return await cmdRefresh(options);
		case "reload":
			return await cmdReload(options);
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
		if (!existsSync(path)) throw new Error(`PIXIP_PI_HOST not found: ${path}`);
		return path;
	}
	const require = createRequire(import.meta.url);
	let packagePath: string;
	try {
		packagePath = require.resolve("pixip-pi-host/package.json");
	} catch {
		throw new Error("pixip-pi-host is not installed; set PIXIP_PI_HOST=<path> or install the workspace");
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

/** Environment a detached daemon needs in addition to its argv. */
function daemonEnv(options: Options): Record<string, string> {
	return !options.useSystemPi && options.piHost ? { PIXIP_PI_HOST: options.piHost } : {};
}

async function serve(options: Options): Promise<void> {
	const paths = daemonPaths(options.dataDir);
	const piHostBin = options.useSystemPi ? undefined : resolvePiHost(options.piHost);
	await mkdir(join(options.dataDir, "sessions"), { recursive: true });

	const existing = await runningDaemon(options.dataDir);
	if (existing && existing.pid !== process.pid) {
		throw new Error(`another pixip is running for ${options.dataDir} (pid ${existing.pid}); stop it first`);
	}

	const entryPath = fileURLToPath(import.meta.url);
	const entryMtime = statSync(entryPath).mtimeMs;
	const startupArgs = serveArgs(options).join("\u0000");
	const loadGeneration = async (generation: number) => {
		const suffix = generation === 0 ? "" : `?gen=${generation}`;
		const hubModule = await import(new URL(`../src/hub.ts${suffix}`, import.meta.url).href);
		const serverModule = await import(new URL(`../src/server.ts${suffix}`, import.meta.url).href);
		return { hub: hubModule, server: serverModule };
	};

	register(new URL("../src/reload/register.ts", import.meta.url).href, import.meta.url);
	const initial = await loadGeneration(0);
	const hub = new initial.hub.Hub({
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

	const running: { server?: RunningServer } = {};
	let watchHandle: WatchHandle | undefined;
	const { GenerationManager } = await import("../src/reload/manager.ts");
	const manager = new GenerationManager({
		initial,
		load: loadGeneration,
		apply: (next: any) => running.server?.applyGeneration(next),
		rollback: (previous: any) => running.server?.rollbackGeneration(previous),
		requiresRestart: () => {
			if (statSync(entryPath).mtimeMs !== entryMtime) return "bin/pixip.ts changed";
			if (serveArgs(options).join("\u0000") !== startupArgs) return "serve flags changed";
			return undefined;
		},
	});

	const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client");
	const server = await initial.server.startServer({
		host: options.host,
		port: options.port,
		hub,
		clientDir,
		log,
		dev: options.dev,
		reloadCode: manager,
		watchCancel: () => watchHandle?.cancel(),
		restart: async (pause?: PauseTarget[]) => {
			const { writePauseSet } = await import("../src/reload/pause.ts");
			await writePauseSet(options.dataDir, pause ?? []);
			await writeResumeSet(options.dataDir, liveSessionIds(await hub.list()));
			spawnRestartHelper(options);
		},
	});
	running.server = server;
	hub.setDaemonUrl(server.url);
	if (options.watch) {
		const { startWatch } = await import("../src/reload/watch.ts");
		const rootDir = fileURLToPath(new URL("..", import.meta.url));
		watchHandle = startWatch({
			roots: [join(rootDir, "src"), join(rootDir, "extensions")],
			reload: () => server.reload(),
			blockers: () => hub.reloadBlockers(),
			log,
			notice: (text, extra) => server.broadcast(frameNotice(text, extra)),
		});
		log(`watch mode: ${options.dev ? "dev" : "serious"} assets, src/ and extensions/`);
	}

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
		env: daemonEnv(options),
	});

	log(`pixip listening on ${server.url}`);
	log(`pid ${process.pid}, data dir ${options.dataDir}, log ${paths.log}`);
	log(
		options.dev
			? "dev mode: client assets re-read per request"
			: "serious mode: client assets served from the startup snapshot",
	);
	if (options.useSystemPi) {
		log(`warning: using system pi at ${options.piBin}; pixip-pi-host capabilities such as the panel are unavailable`);
	}
	if (options.host !== "127.0.0.1" && options.host !== "::1") {
		log(`warning: bound to ${options.host}; this UI has no authentication`);
	}

	// A restart persists the sessions that were live so the new daemon can put
	// the dashboard's hot/warm set back before the browser even reconnects.
	void resumeRestartedSessions(hub, options.dataDir, server);

	const softRefresh = async (label: string) => {
		try {
			const report = await server.refresh();
			log(`${label}: reloaded ${report.reloaded.join(", ")} (${report.reloads} total)`);
		} catch (error) {
			log(`${label} failed: ${(error as Error).message}`);
		}
	};
	process.on("SIGHUP", () => void softRefresh("SIGHUP"));

	let reloadChain: Promise<unknown> = Promise.resolve();
	const daemonReload = (label: string) => {
		const run = reloadChain.then(() => server.reload());
		reloadChain = run.then(
			() => undefined,
			() => undefined,
		);
		void run
			.then(async (report) => {
				log(`${label}: ${report.message}`);
				await writeReloadResult(options.dataDir, report).catch((error: unknown) => {
					log(`${label}: could not write reload result: ${(error as Error).message}`);
				});
			})
			.catch((error: unknown) => log(`${label} failed: ${(error as Error).message}`));
	};
	process.on("SIGUSR1", () => daemonReload("SIGUSR1"));

	let closing = false;
	const shutdown = async (signal: string, restart = false) => {
		if (closing) return;
		closing = true;
		watchHandle?.close();
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

async function cmdDaemon(options: Options): Promise<void> {
	await mkdir(join(options.dataDir, "sessions"), { recursive: true });
	const running = await runningDaemon(options.dataDir);
	if (running) throw new Error(`pixip is already running for ${options.dataDir} (pid ${running.pid})`);
	if (!(await portAvailable(options.host, options.port))) {
		throw new Error(`port ${options.port} is already in use on ${options.host}`);
	}
	const state = await startDaemon({
		dataDir: options.dataDir,
		args: serveArgs(options),
		env: daemonEnv(options),
	});
	process.stdout.write(`pixip listening on ${state.url} (pid ${state.pid})\n`);
}

async function cmdStop(options: Options): Promise<void> {
	// Never let a bash tool inside a session take the service down. Stopping the
	// daemon is a user action now; the old "stop means restart" conversion made
	// an agent-triggered stop indistinguishable from a real one.
	if (insidePixip()) {
		process.stderr.write(
			"stop is user-only inside a pixip session, please ask your user to run the /pixup-restart command\n",
		);
		process.exitCode = 2;
		return;
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
		const hub = await offlineHub(options);
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

/** Persist the current live set before the helper replaces the daemon. */
async function recordLiveSessions(url: string, dataDir: string): Promise<void> {
	const sessions = await fetchSessions(url).catch(() => []);
	await writeResumeSet(dataDir, liveSessionIds(sessions));
}

/** New daemon side: put back the live children and resume the opted-in pause set. */
async function resumeRestartedSessions(hub: Hub, dataDir: string, server?: RunningServer): Promise<void> {
	const { formatPauseReport, resumePaused, takePauseSet } = await import("../src/reload/pause.ts");
	const pause = await takePauseSet(dataDir);
	const ids = await takeResumeSet(dataDir);
	if (ids.length > 0) {
		log(`[restart] resuming ${ids.length} session(s)`);
		for (const id of ids) {
			try {
				await hub.attach(id);
			} catch (error) {
				log(`[restart] could not resume ${id}: ${(error as Error).message}`);
			}
		}
	}
	if (pause.length > 0) {
		const report = await resumePaused(hub, pause);
		log(`[restart] ${formatPauseReport(report)}`);
		server?.setPauseResult(report);
	}
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
	const state = await startDaemon({ dataDir: options.dataDir, args, env: running?.env ?? daemonEnv(options) });
	note(`listening on ${state.url} (pid ${state.pid})`);
}

async function cmdRestart(options: Options): Promise<void> {
	if (options.detached) return await runRestartHelper(options);

	const running = await runningDaemon(options.dataDir);
	if (!running) {
		// Idempotent: restarting a stopped data dir is just a start.
		await cmdDaemon(options);
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
	await recordLiveSessions(running.url, options.dataDir);
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

/** `pixip reload`: SIGUSR1 the daemon, then poll the result file for exit status. */
async function cmdReload(options: Options): Promise<void> {
	if (insidePixip()) {
		process.stderr.write("reload is user-only, please ask your user to run the /reload command\n");
		process.exitCode = 2;
		return;
	}
	const running = await runningDaemon(options.dataDir);
	if (!running) {
		process.stderr.write(`pixip is not running for ${options.dataDir}\n`);
		process.exitCode = 1;
		return;
	}
	const path = daemonPaths(options.dataDir).reload;
	const before = await stat(path)
		.then((info) => info.mtimeMs)
		.catch(() => 0);
	try {
		process.kill(running.pid, "SIGUSR1");
	} catch (error) {
		process.stderr.write(`could not signal pixip (${(error as Error).message})\n`);
		process.exitCode = 1;
		return;
	}
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const after = await stat(path)
			.then((info) => info.mtimeMs)
			.catch(() => 0);
		if (after > before) {
			let report: ReloadReport;
			try {
				report = JSON.parse(readFileSync(path, "utf8")) as ReloadReport;
			} catch (error) {
				process.stderr.write(`could not read reload result: ${(error as Error).message}\n`);
				process.exitCode = 1;
				return;
			}
			if (report.ok) {
				process.stdout.write(`${report.message}\n`);
				return;
			}
			process.stderr.write(`${report.message}\n`);
			process.exitCode = 1;
			return;
		}
		await delay(100);
	}
	process.stderr.write(`reload timed out after 30s (see ${daemonPaths(options.dataDir).log})\n`);
	process.exitCode = 1;
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
		throw new Error(`pixip is not running for ${options.dataDir}; start it with \`pixip daemon\``);
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
	const { INBOX_PURPOSES } = await import("../src/inbox.ts");
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

// ------------------------------------------------------------------- ref

async function cmdRef(options: Options): Promise<void> {
	if (options.positionals.length !== 1) throw new Error("usage: pixip ref <tag> [--json]");
	const ref = parseRefArg(options.positionals[0] as string);
	const hub = await offlineHub(options);
	try {
		const result = await resolveRef(hub, options.dataDir, ref);
		process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${formatRef(result)}\n`);
	} catch (error) {
		if (!(error instanceof RefResolutionError)) throw error;
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
	} finally {
		await hub.shutdown();
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

async function offlineHub(options: Options): Promise<Hub> {
	const { Hub } = await import("../src/hub.ts");
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

	const hub = await offlineHub(options);
	try {
		const [listing, sessions] = await Promise.all([hub.listWorktrees(cwd), hub.list()]);
		return { ...listing, sessions, source: "offline" };
	} finally {
		await hub.shutdown();
	}
}

async function findWorktree(entries: WorktreeEntry[], target: string): Promise<WorktreeEntry | undefined> {
	const { realCwd } = await import("../src/worktree.ts");
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

	const hub = await offlineHub(options);
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
	const { detectRepo, pruneWorktrees } = await import("../src/worktree.ts");
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

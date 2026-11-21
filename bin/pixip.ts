#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hub } from "../src/hub.ts";
import { startServer } from "../src/server.ts";

/**
 * pixip — supervisor + web UI for Pi sessions.
 *
 * `--data-dir` is the isolation boundary used for testing: Pi runs with
 * `--session-dir <data-dir>/sessions`, so the prototype never touches the real
 * `~/.pi/agent/sessions`. Point it at a scratch directory and nothing else on the
 * box is affected.
 */

interface Options {
	host: string;
	port: number;
	dataDir: string;
	piBin: string;
	idleMs: number;
	dev: boolean;
	allowCommands: string[];
	denyCommands: string[];
	noBash: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		host: "127.0.0.1",
		port: 8137,
		dataDir: resolve("tmp/dev"),
		piBin: "pi",
		idleMs: 15 * 60_000,
		dev: false,
		allowCommands: [],
		denyCommands: [],
		noBash: false,
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
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	return options;
}

function printHelp(): void {
	process.stdout.write(`pixip — phone-first web transcript for Pi sessions

Usage: pixip [options]

  --host <address>    bind address (default 127.0.0.1)
  --port <number>     port (default 8137)
  --data-dir <path>   isolation root; sessions live in <path>/sessions
                      (default ./tmp/dev), never ~/.pi/agent/sessions
  --pi <path>         pi executable (default: pi from PATH)
  --idle-ms <ms>      detach an idle session after this long, keeping its JSONL
                      for resume (default 900000; 0 disables)
  --dev               re-read client assets per request (no restart on CSS/JS edits)
  --allow-command <name>
                      allow only these commands (repeatable); merged with
                      <data-dir>/pixip.json and <cwd>/.pixip.json, which can
                      only narrow the result
  --deny-command <name>
                      block a command by name (repeatable); deny wins
  --no-bash           disable !/!! (same as "bash": false in pixip.json)
`);
}

function log(message: string): void {
	const stamp = new Date().toISOString().slice(11, 23);
	process.stderr.write(`${stamp} ${message}\n`);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const sessionsDir = join(options.dataDir, "sessions");
	await mkdir(sessionsDir, { recursive: true });

	const hub = new Hub({
		piBin: options.piBin,
		sessionsDir,
		dataDir: options.dataDir,
		indexPath: join(options.dataDir, "sessions.json"),
		idleMs: options.idleMs,
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

	log(`pixip listening on ${server.url}`);
	log(`sessions dir: ${sessionsDir}`);
	if (options.host !== "127.0.0.1" && options.host !== "::1") {
		log(`warning: bound to ${options.host}; this UI has no authentication`);
	}

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) return;
		closing = true;
		log(`${signal}: shutting down`);
		await server.close();
		await hub.shutdown();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
	log(`fatal: ${(error as Error).message}`);
	process.exit(1);
});

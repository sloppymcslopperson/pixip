#!/usr/bin/env node
import { VERSION } from "@earendil-works/pi-coding-agent";

import { parseHostArgs } from "./args.ts";
import { parsePrintArgs, printOnce } from "./print.ts";
import { attachJsonlLineReader, PiHost, serializeJsonLine } from "./protocol.ts";
import { createHostRuntime, startupExtensionErrors } from "./runtime.ts";

function write(record: unknown): void {
	process.stdout.write(serializeJsonLine(record));
}

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "--print" || argv[0] === "-p") {
		const text = await printOnce(parsePrintArgs(argv));
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
		return;
	}
	const args = parseHostArgs(argv);
	const runtime = await createHostRuntime(args);
	const host = new PiHost({
		runtime,
		output: write,
		piVersion: VERSION,
		exit: (code) => process.exit(code),
	});

	const shutdown = (code: number) => {
		void host.shutdown(code);
	};
	process.on("SIGTERM", () => shutdown(143));
	if (process.platform !== "win32") process.on("SIGHUP", () => shutdown(129));

	await host.start();
	for (const error of startupExtensionErrors(runtime)) write(error);

	const detach = attachJsonlLineReader(process.stdin, (line) => {
		void host.handleLine(line);
	});
	process.stdin.on("end", () => {
		detach();
		shutdown(0);
	});
	process.stdin.resume();
}

run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	write({
		type: "extension_error",
		extensionPath: "pixip-pi-host",
		event: "startup",
		error: message,
	});
	console.error(`pixip-pi-host: ${message}`);
	process.exit(1);
});

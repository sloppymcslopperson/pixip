#!/usr/bin/env node
/**
 * Run the test suite with file-level concurrency sized to the machine.
 *
 * `npm test` runs every `test/*.test.js` and `test/*.test.ts` file.
 * `npm run test:fast` runs the same set minus the four process-heavy suites.
 * The runner uses `os.availableParallelism()` so a 2-core box gets 2 workers and
 * a 24-core laptop gets 24, instead of a hard-coded number.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAST_EXCLUDES = new Set(["daemon.test.ts", "backend.test.ts", "reload.test.ts", "worktree-cli.test.ts"]);

const fast = process.argv.includes("--fast");
const entries = await readdir(join(ROOT, "test"));
const files = entries
	.filter((name) => /\.test\.(?:js|ts)$/.test(name))
	.filter((name) => !fast || !FAST_EXCLUDES.has(name))
	.sort()
	.map((name) => join("test", name));

const concurrency = Math.max(1, availableParallelism());
const child = spawn(
	process.execPath,
	["--import", "./test/setup.ts", "--test", `--test-concurrency=${concurrency}`, ...files],
	{ cwd: ROOT, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exitCode = code ?? 1;
});

#!/usr/bin/env node
/**
 * Check every workspace once from the root.
 *
 * Root `check:static` already typechecks/lints/formats the root project and
 * runs the client import guard. This script covers the four workspaces without
 * paying for a full tool startup per workspace check:
 *
 * - workspace typechecks run concurrently and reuse an incremental
 *   `tsBuildInfoFile` under `node_modules/.cache/tsbuildinfo`;
 * - workspace lints run concurrently and reuse an ESLint cache under
 *   `node_modules/.cache/eslint`;
 * - each workspace's own test suite still runs.
 *
 * Formatting is deliberately not repeated here: the root `format:check`
 * already covers the whole tree. `npm run check --workspace <name>` keeps its
 * full standalone behaviour.
 *
 *   npm run check:workspaces
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** Keep the heavy typed-lint phase to two workers on a 2-CPU box. */
const PHASES = [
	{ name: "typecheck", script: "typecheck", concurrency: 4 },
	{ name: "lint", script: "lint", concurrency: 2 },
	{ name: "test", script: "test", concurrency: 4 },
];

const children = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => {
		for (const child of children) child.kill(signal);
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

function seconds(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function run(name, script) {
	return new Promise((resolve) => {
		const started = process.hrtime.bigint();
		const child = spawn(NPM, ["run", "--silent", script, "--workspace", name], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0" },
		});
		children.add(child);

		let output = "";
		const append = (chunk) => {
			output += chunk.toString();
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => {
			output += `failed to start: ${error.message}\n`;
		});
		child.on("close", (code, signal) => {
			children.delete(child);
			resolve({
				name,
				script,
				code,
				signal,
				output,
				ms: Number(process.hrtime.bigint() - started) / 1e6,
			});
		});
	});
}

async function workspaces() {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const dirs = [];
	for (const pattern of pkg.workspaces ?? []) {
		const star = pattern.indexOf("*");
		if (star === -1) {
			dirs.push(join(ROOT, pattern));
			continue;
		}
		const base = pattern.slice(0, star).replace(/\/$/, "");
		for (const entry of await readdir(join(ROOT, base), { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.push(join(ROOT, base, entry.name));
		}
	}

	const found = [];
	for (const dir of dirs) {
		try {
			const workspace = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			if (workspace.name) found.push(workspace.name);
		} catch {
			// A directory without a package.json is not a workspace.
		}
	}
	return found;
}

async function runPhase(phase, names) {
	const results = [];
	let next = 0;
	async function worker() {
		while (next < names.length) {
			const name = names[next++];
			const result = await run(name, phase.script);
			results.push(result);
			const status = result.code === 0 ? "ok" : "FAIL";
			console.log(`  ${phase.name.padEnd(10)} ${name.padEnd(22)} ${status} ${seconds(result.ms)}`);
		}
	}
	await Promise.all(Array.from({ length: Math.min(phase.concurrency, names.length) }, worker));
	return results;
}

const names = await workspaces();
console.log(`check:workspaces: ${names.length} workspaces (${names.join(", ")})`);

const results = [];
for (const phase of PHASES) {
	results.push(...(await runPhase(phase, names)));
}

for (const result of results) {
	if (result.code === 0) continue;
	console.log(`\n--- ${result.name} ${result.script} output ---`);
	process.stdout.write(result.output);
	if (result.output && !result.output.endsWith("\n")) process.stdout.write("\n");
	console.log(`--- end ${result.name} ${result.script} ---`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
	console.error(
		`\ncheck:workspaces: ${failed.length} failure(s): ${failed.map((result) => `${result.name} ${result.script}`).join(", ")}`,
	);
	process.exitCode = 1;
} else {
	const total = results.reduce((sum, result) => sum + result.ms, 0);
	console.log(`\ncheck:workspaces: all ${results.length} phase runs passed (sum ${seconds(total)})`);
}

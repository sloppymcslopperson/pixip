#!/usr/bin/env node
/**
 * Run the four independent static gates concurrently.
 *
 * The gates read the tree and write nothing, so they are safe to overlap. Each
 * child's output is buffered and printed as one attributed section once the
 * group finishes, which keeps two failures legible in a single run. The run
 * waits for every gate, then exits non-zero if any failed.
 *
 *   npm run check:static
 */
import { spawn } from "node:child_process";

/** Cheap gates first so the start order mirrors the old serial chain. */
const STEPS = [
	{ name: "check:imports", script: "check:imports" },
	{ name: "format:check", script: "format:check" },
	{ name: "typecheck", script: "typecheck" },
	{ name: "lint", script: "lint" },
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.once(signal, () => {
		for (const child of children) child.kill(signal);
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

function runStep(step) {
	return new Promise((resolve) => {
		const started = process.hrtime.bigint();
		const child = spawn(npm, ["run", "--silent", step.script], {
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
			output += `failed to start ${step.name}: ${error.message}\n`;
		});
		child.on("close", (code, signal) => {
			children.delete(child);
			resolve({
				...step,
				code,
				signal,
				output,
				ms: Number(process.hrtime.bigint() - started) / 1e6,
			});
		});
	});
}

function seconds(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

console.log(`check:static: running ${STEPS.length} gates concurrently (${STEPS.map((step) => step.name).join(", ")})`);

const results = await Promise.all(STEPS.map(runStep));

for (const result of results) {
	const status = result.code === 0 ? "PASS" : "FAIL";
	console.log(`\n=== ${result.name} · ${status} · ${seconds(result.ms)} ===`);
	if (result.output) {
		process.stdout.write(result.output);
		if (!result.output.endsWith("\n")) process.stdout.write("\n");
	}
}

console.log("\ncheck:static summary");
for (const result of results) {
	const status = result.code === 0 ? "PASS" : "FAIL";
	const detail = result.signal ? ` (signal ${result.signal})` : "";
	console.log(`  ${status}  ${result.name.padEnd(14)} ${seconds(result.ms)}${detail}`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
	console.error(`\ncheck:static: ${failed.length} gate(s) failed: ${failed.map((result) => result.name).join(", ")}`);
	process.exitCode = 1;
}

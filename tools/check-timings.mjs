#!/usr/bin/env node
/**
 * Repeatable per-step timing report for the full `npm run check` pipeline.
 *
 * Runs the same steps as `check` sequentially, records wall time and exit
 * status for each, then profiles each test file on its own so the slow files
 * are ranked once. Node's combined TAP output does not identify the file behind
 * a top-level suite, so a separate bounded per-file pass is the reliable way to
 * attribute test time.
 *
 *   npm run check:timings
 *
 * Budgets are soft: an over-budget step prints a warning, while the exit code
 * follows the real step results.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const FILE_CONCURRENCY = Math.max(1, availableParallelism());
const TEST_CONCURRENCY = Math.max(1, availableParallelism());

/** Soft budgets in seconds, from the settled full pipeline. */
const BUDGETS = {
	"check:static": 55,
	"test:full": 70,
	"check:browser": 40,
	"check:workspaces": 60,
};

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

function run(command, args) {
	return new Promise((resolve) => {
		const started = process.hrtime.bigint();
		const child = spawn(command, args, {
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
				code,
				signal,
				output,
				ms: Number(process.hrtime.bigint() - started) / 1e6,
			});
		});
	});
}

async function testFiles() {
	const entries = await readdir(join(ROOT, "test"));
	return entries
		.filter((name) => /\.test\.(?:js|ts)$/.test(name))
		.sort()
		.map((name) => join("test", name));
}

/**
 * Top-level TAP entries carry the suite duration including nested tests, so
 * reading only unindented `ok` blocks avoids counting a nested test twice.
 */
function topLevelSuites(tap) {
	const lines = tap.split("\n");
	const suites = [];
	for (let index = 0; index < lines.length; index++) {
		const match = /^(?:ok|not ok) \d+ - (.*)$/.exec(lines[index]);
		if (!match) continue;
		let duration = null;
		for (let next = index + 1; next < lines.length; next++) {
			if (/^\s*\.\.\.\s*$/.test(lines[next])) break;
			const value = /^\s*duration_ms:\s*([\d.]+)/.exec(lines[next]);
			if (value) duration = Number(value[1]);
		}
		if (duration !== null) suites.push({ name: match[1], ms: duration });
	}
	return suites.sort((left, right) => right.ms - left.ms);
}

/** Profile each test file on its own; the full suite was already timed above. */
async function timeFiles(files, limit) {
	const results = [];
	let next = 0;
	async function worker() {
		while (next < files.length) {
			const file = files[next++];
			const result = await run(process.execPath, ["--import", "./test/setup.ts", "--test", file]);
			results.push({ file, ms: result.ms, ok: result.code === 0 });
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
	return results;
}

function printFailure(step) {
	console.log(`\n--- ${step.name} output ---`);
	process.stdout.write(step.output);
	if (step.output && !step.output.endsWith("\n")) process.stdout.write("\n");
	console.log(`--- end ${step.name} ---`);
}

const files = await testFiles();

const steps = [
	{ name: "check:static", command: NPM, args: ["run", "--silent", "check:static"], budget: BUDGETS["check:static"] },
	{
		name: "test:full",
		command: process.execPath,
		args: [
			"--import",
			"./test/setup.ts",
			"--test",
			`--test-concurrency=${TEST_CONCURRENCY}`,
			"--test-reporter=tap",
			...files,
		],
		budget: BUDGETS["test:full"],
	},
	{ name: "check:browser", command: NPM, args: ["run", "--silent", "check:browser"], budget: BUDGETS["check:browser"] },
	{
		name: "check:workspaces",
		command: NPM,
		args: ["run", "--silent", "check:workspaces"],
		budget: BUDGETS["check:workspaces"],
	},
];

console.log(`check:timings: ${steps.length} steps, ${files.length} test files`);
const results = [];
for (const step of steps) {
	process.stdout.write(`  ${step.name} ... `);
	const result = await run(step.command, step.args);
	const entry = { ...step, ...result };
	results.push(entry);
	console.log(`${result.code === 0 ? "ok" : "FAIL"} ${seconds(result.ms)}`);
	if (result.code !== 0) printFailure(entry);
}

const testResult = results.find((entry) => entry.name === "test:full");
const suites = testResult.code === 0 ? topLevelSuites(testResult.output) : [];
let fileResults = [];
if (testResult.code === 0) {
	console.log(`\ncheck:timings: profiling individual test files (${FILE_CONCURRENCY} at a time)`);
	fileResults = await timeFiles(files, FILE_CONCURRENCY);
}

const total = results.reduce((sum, entry) => sum + entry.ms, 0);

console.log("\nstep                                        wall    status  budget");
for (const entry of results) {
	const status = entry.code === 0 ? "ok" : "FAIL";
	console.log(`  ${entry.name.padEnd(40)} ${seconds(entry.ms).padStart(6)}  ${status.padEnd(6)}  ${entry.budget}s`);
}
console.log(`  ${"total".padEnd(40)} ${seconds(total).padStart(6)}`);

const overBudget = results.filter((entry) => entry.ms > entry.budget * 1000);
if (overBudget.length > 0) {
	console.log("\nbudget warnings (soft; not a failure):");
	for (const entry of overBudget) {
		console.log(`  ${entry.name}: ${seconds(entry.ms)} over ${entry.budget}s budget`);
	}
}

if (suites.length > 0) {
	console.log("\nslowest test suites (TAP top-level, nested time counted once):");
	for (const suite of suites.slice(0, 10)) {
		console.log(`  ${seconds(suite.ms).padStart(7)}  ${suite.name}`);
	}
}

if (fileResults.length > 0) {
	fileResults.sort((left, right) => right.ms - left.ms);
	console.log("\nslowest test files (isolated pass, wall time):");
	for (const result of fileResults.slice(0, 10)) {
		console.log(`  ${seconds(result.ms).padStart(7)}  ${result.ok ? "ok  " : "FAIL"}  ${result.file}`);
	}
	const failures = fileResults.filter((result) => !result.ok);
	if (failures.length > 0) {
		console.log(`\nfile pass warnings: ${failures.length} file(s) failed when run alone`);
	}
}

const failed = results.filter((entry) => entry.code !== 0);
if (failed.length > 0) {
	console.error(`\ncheck:timings: ${failed.length} step(s) failed: ${failed.map((entry) => entry.name).join(", ")}`);
	process.exitCode = 1;
}

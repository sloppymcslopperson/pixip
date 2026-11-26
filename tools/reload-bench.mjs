#!/usr/bin/env node
/**
 * In-place reload benchmark. Starts a real daemon with no live children, then
 * measures:
 *
 *   - soft refresh (`POST /api/refresh`): assets/policy/index only
 *   - `/reload` (SIGUSR1): import the next daemon generation, swap the hub
 *     prototype/server impl, commit assets and policy, then reload children
 *   - the difference as a rough cost of the code-generation swap
 *
 * `npm run check` does not run this: a 1 vCPU box is too noisy for a gate.
 *
 *   node tools/reload-bench.mjs
 *   node tools/reload-bench.mjs --runs 9
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(ROOT, "bin", "pixip.ts");
const args = process.argv.slice(2);
const at = args.indexOf("--runs");
const runs = at >= 0 && args[at + 1] ? Number(args[at + 1]) : 7;

const env = { ...process.env };
delete env["PIXIP_INSIDE"];
delete env["PIXIP_SESSION_ID"];
delete env["PIXIP_DATA_DIR"];

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
	const server = createServer();
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address();
	await new Promise((done) => server.close(done));
	return port;
}

async function waitFor(fn, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn().catch(() => undefined);
		if (value) return value;
		if (Date.now() >= deadline) throw new Error("timed out waiting for daemon");
		await delay(50);
	}
}

function runCli(args) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("exit", (code) => resolveRun({ code, stdout, stderr }));
	});
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(label, values) {
	const median = percentile(values, 0.5);
	const p95 = percentile(values, 0.95);
	console.log(`${label.padEnd(24)} median ${median.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms`);
	return { label, median, p95 };
}

const dir = await mkdtemp(join(tmpdir(), "pixip-reload-bench-"));
const port = await freePort();
const child = spawn(process.execPath, [CLI, "daemon", "--data-dir", dir, "--port", String(port)], {
	env,
	stdio: ["ignore", "pipe", "pipe"],
});
let daemonLog = "";
child.stdout.on("data", (chunk) => (daemonLog += chunk));
child.stderr.on("data", (chunk) => (daemonLog += chunk));

try {
	const state = await waitFor(async () => {
		const text = await readFile(join(dir, "pixip.state.json"), "utf8");
		return JSON.parse(text);
	});
	const url = state.url;
	const health = await waitFor(async () => {
		const response = await fetch(new URL("health", url));
		return response.ok ? response.json() : undefined;
	});
	assert.equal(health.generation, 0);

	const reloadPath = join(dir, "pixip.reload.json");
	const reloadOnce = async () => {
		const before = await stat(reloadPath)
			.then((info) => info.mtimeMs)
			.catch(() => 0);
		process.kill(state.pid, "SIGUSR1");
		await waitFor(async () => {
			const after = await stat(reloadPath)
				.then((info) => info.mtimeMs)
				.catch(() => 0);
			return after > before ? true : undefined;
		});
		return JSON.parse(await readFile(reloadPath, "utf8"));
	};

	// Warm the module graph once so the reported number is a steady-state swap,
	// not the first cold import of every src file.
	const warm = await reloadOnce();
	assert.equal(warm.ok, true, warm.message);

	const refreshTimes = [];
	for (let index = 0; index < runs; index += 1) {
		const started = performance.now();
		const response = await fetch(new URL("api/refresh", url), { method: "POST" });
		assert.equal(response.ok, true);
		await response.json();
		refreshTimes.push(performance.now() - started);
	}

	const reloadTimes = [];
	let generation = warm.generation;
	for (let index = 0; index < runs; index += 1) {
		const started = performance.now();
		const report = await reloadOnce();
		reloadTimes.push(performance.now() - started);
		assert.equal(report.ok, true, report.message);
		generation += 1;
		assert.equal(report.generation, generation);
	}

	const refresh = summarize("soft refresh", refreshTimes);
	const reload = summarize("/reload (code swap)", reloadTimes);
	console.log(`\nrough generation-swap cost: ${(reload.median - refresh.median).toFixed(1)} ms median`);
	console.log(`final generation: ${generation}`);
	console.log(`data dir: ${dir}`);
	console.log(JSON.stringify({ refresh, reload }, null, 2));
} finally {
	await runCli(["stop", "--data-dir", dir]);
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	await rm(dir, { recursive: true, force: true });
	if (daemonLog.trim()) console.error(daemonLog.trim());
}

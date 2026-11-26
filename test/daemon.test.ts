import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { pidAlive, readDaemonState, refreshDaemon, runningDaemon, fetchHealth, fetchSessions } from "../src/daemon.ts";
import { FIXTURE, HOST_FIXTURE, cleanupRoots, tempRoot, testRoots, waitFor } from "./helpers/harness.ts";

const CLI = fileURLToPath(new URL("../bin/pixip.ts", import.meta.url));

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run the CLI, resolving on exit (non-zero included); never throws on status. */
function cli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ env: { ...process.env, ...env }, timeout: 60_000 },
			(error, stdout, stderr) => {
				const exit = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code: exit, stdout, stderr });
			},
		);
	});
}

/** `daemon` on an ephemeral port; returns the printed URL and the state. */
async function daemon(
	dir: string,
	env: Record<string, string> = {},
	options: { system?: boolean } = {},
): Promise<{ url: string; pid: number }> {
	const backend = options.system === false ? [] : ["--use-system-pi", "--pi", FIXTURE];
	const result = await cli(["daemon", "--data-dir", dir, "--port", "0", ...backend], env);
	assert.equal(result.code, 0, result.stderr);
	const match = /on (http\S+)/.exec(result.stdout);
	assert.ok(match?.[1], result.stdout);
	const state = await readDaemonState(dir);
	assert.ok(state);
	assert.equal(state.url, match?.[1]);
	return { url: state.url, pid: state.pid };
}

async function createSession(url: string, cwd: string): Promise<Record<string, unknown>> {
	const response = await fetch(new URL("api/sessions", url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd }),
	});
	const text = await response.text();
	assert.equal(response.status, 200, text);
	return JSON.parse(text) as Record<string, unknown>;
}

before(async () => {
	await chmod(FIXTURE, 0o755);
});

after(async () => {
	for (const dir of testRoots()) {
		const state = await readDaemonState(dir);
		if (state && pidAlive(state.pid)) {
			try {
				process.kill(state.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
	await cleanupRoots();
});

describe("daemon lifecycle", () => {
	it("starts, reports, refreshes, tails and stops one data dir", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { url, pid } = await daemon(dir);

		const state = await readDaemonState(dir);
		assert.equal(state?.pid, pid);
		assert.equal(state?.dataDir, dir);
		assert.equal(state?.port, Number(new URL(url).port));
		assert.deepEqual(state?.args.slice(0, 2), ["--host", "127.0.0.1"]);

		const status = await cli(["status", "--data-dir", dir, "--json"]);
		assert.equal(status.code, 0);
		const info = JSON.parse(status.stdout) as Record<string, unknown>;
		assert.equal(info["running"], true);
		assert.equal(info["pid"], pid);
		assert.equal(info["url"], url);
		assert.equal(info["sessions"], 0);
		assert.equal(info["reloads"], 0);

		const second = await cli(["daemon", "--data-dir", dir, "--port", "0", "--use-system-pi", "--pi", FIXTURE]);
		assert.equal(second.code, 1);
		assert.match(second.stderr, /already running/);

		const refreshed = await cli(["refresh", "--data-dir", dir]);
		assert.equal(refreshed.code, 0, refreshed.stderr);
		assert.match(refreshed.stdout, /assets, config, index, commands/);
		const health = await fetchHealth(url);
		assert.equal(health.reloads, 1);
		assert.ok((health.startedAt ?? 0) > 0);
		assert.equal(health.pid, pid);

		const logs = await cli(["logs", "--data-dir", dir, "--lines", "6"]);
		assert.equal(logs.code, 0, logs.stderr);
		assert.match(logs.stdout, /listening on/);

		const stopped = await cli(["stop", "--data-dir", dir]);
		assert.equal(stopped.code, 0, stopped.stderr);
		assert.match(stopped.stdout, /stopped pixip/);
		assert.equal(pidAlive(pid), false);
		await waitFor(async () => (await runningDaemon(dir)) === undefined);

		const down = await cli(["status", "--data-dir", dir]);
		assert.equal(down.code, 1);
		assert.match(down.stdout, /not running/);
		const downJson = await cli(["status", "--data-dir", dir, "--json"]);
		assert.equal(downJson.code, 1);
		assert.equal(JSON.parse(downJson.stdout).running, false);
	});

	it("serves in the foreground with run until SIGTERM", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const child = spawn(
			process.execPath,
			[CLI, "run", "--data-dir", dir, "--port", "0", "--use-system-pi", "--pi", FIXTURE],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			await waitFor(() => output.includes("pixip listening on"), 15_000);
			const state = await readDaemonState(dir);
			assert.ok(state);
			assert.equal(state.pid, child.pid);
			const health = await fetchHealth(state.url);
			assert.equal(health.pid, child.pid);
			assert.match(output, /dev mode: client assets re-read per request/);
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
		await waitFor(async () => (await runningDaemon(dir)) === undefined);
	});

	it("records serious mode in daemon state", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const result = await cli([
			"daemon",
			"--data-dir",
			dir,
			"--port",
			"0",
			"--use-system-pi",
			"--pi",
			FIXTURE,
			"--serious-mode",
		]);
		assert.equal(result.code, 0, result.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state);
		assert.ok(state.args.includes("--serious-mode"));
		const logs = await cli(["logs", "--data-dir", dir, "--lines", "10"]);
		assert.match(logs.stdout, /serious mode: client assets served from the startup snapshot/);
		await cli(["stop", "--data-dir", dir]);
	});

	it("rejects the retired command names and the old dev flag", async () => {
		const dir = await tempRoot("pixip-daemon-");
		for (const name of ["serve", "start"]) {
			const result = await cli([name, "--data-dir", dir]);
			assert.equal(result.code, 1, name);
			assert.match(result.stderr, new RegExp(`unknown command ${name}`), name);
		}
		const dev = await cli(["run", "--dev", "--data-dir", dir]);
		assert.equal(dev.code, 1);
		assert.match(dev.stderr, /unknown argument --dev/);
	});

	it("cleans a stale pid instead of failing", async () => {
		const dir = await tempRoot("pixip-daemon-");
		await writeFile(join(dir, "pixip.pid"), "999999\n");
		await writeFile(
			join(dir, "pixip.state.json"),
			JSON.stringify({
				pid: 999999,
				host: "127.0.0.1",
				port: 1,
				url: "http://127.0.0.1:1/",
				startedAt: new Date(0).toISOString(),
				dataDir: dir,
				args: [],
			}),
		);
		assert.equal(await runningDaemon(dir), undefined);

		const status = await cli(["status", "--data-dir", dir]);
		assert.equal(status.code, 1);
		await assert.rejects(readFile(join(dir, "pixip.pid"), "utf8"), /ENOENT/);

		const { pid } = await daemon(dir);
		assert.ok(pidAlive(pid));
		await cli(["stop", "--data-dir", dir]);
	});

	it("turns stop from inside a pixip session into a restart", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { pid } = await daemon(dir);
		const result = await cli(["stop", "--data-dir", dir], { PIXIP_INSIDE: "1" });
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stderr, /restarting instead/);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		assert.equal(pidAlive(pid), false);
		// From a normal shell the same command really stops it.
		const stopped = await cli(["stop", "--data-dir", dir]);
		assert.equal(stopped.code, 0, stopped.stderr);
		assert.match(stopped.stdout, /stopped pixip/);
		assert.equal(await runningDaemon(dir), undefined);
	});

	it("does not start a daemon when an inside stop finds none running", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const result = await cli(["stop", "--data-dir", dir], { PIXIP_INSIDE: "1" });
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /not running/);
		assert.equal(await runningDaemon(dir), undefined);
	});

	it("answers SIGHUP with a soft refresh", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { url, pid } = await daemon(dir);
		process.kill(pid, "SIGHUP");
		await waitFor(async () => (await fetchHealth(url).catch(() => ({ reloads: 0 }))).reloads === 1);
		const report = await refreshDaemon(dir);
		assert.equal(report.reloads, 2);
		await cli(["stop", "--data-dir", dir]);
	});
});

describe("backend selection", () => {
	it("spawns the host by default and records PIXIP_PI_HOST for restart", async () => {
		const dir = await tempRoot("pixip-backend-");
		const spawnLog = join(dir, "host.jsonl");
		const { url } = await daemon(dir, { PIXIP_PI_HOST: HOST_FIXTURE, FAKE_HOST_LOG: spawnLog }, { system: false });
		const state = await readDaemonState(dir);
		assert.deepEqual(state?.env, { PIXIP_PI_HOST: HOST_FIXTURE });
		assert.ok(!state?.args.includes("--pi"));
		assert.ok(!state?.args.includes("--use-system-pi"));

		await createSession(url, dir);
		await waitFor(async () => (await readFile(spawnLog, "utf8").catch(() => "")).includes('"type":"spawn"'));
		const logs = await cli(["logs", "--data-dir", dir, "--lines", "20"]);
		assert.doesNotMatch(logs.stdout, /using system pi/);
		await cli(["stop", "--data-dir", dir]);
	});

	it("restarts with the recorded host environment", async () => {
		const dir = await tempRoot("pixip-backend-");
		const spawnLog = join(dir, "host.jsonl");
		const { pid } = await daemon(dir, { PIXIP_PI_HOST: HOST_FIXTURE, FAKE_HOST_LOG: spawnLog }, { system: false });
		const restarted = await cli(["restart", "--data-dir", dir]);
		assert.equal(restarted.code, 0, restarted.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		assert.deepEqual(state.env, { PIXIP_PI_HOST: HOST_FIXTURE });
		await cli(["stop", "--data-dir", dir]);
	});

	it("logs a warning for the system backend", async () => {
		const dir = await tempRoot("pixip-backend-");
		await daemon(dir);
		const logs = await cli(["logs", "--data-dir", dir, "--lines", "20"]);
		assert.match(logs.stdout, /warning: using system pi at/);
		await cli(["stop", "--data-dir", dir]);
	});

	it("requires --use-system-pi for --pi and PIXIP_PI", async () => {
		const dir = await tempRoot("pixip-backend-");
		const flag = await cli(["daemon", "--data-dir", dir, "--port", "0", "--pi", FIXTURE]);
		assert.equal(flag.code, 1);
		assert.match(flag.stderr, /--use-system-pi/);

		const env = await cli(["daemon", "--data-dir", dir, "--port", "0"], { PIXIP_PI: FIXTURE });
		assert.equal(env.code, 1);
		assert.match(env.stderr, /--use-system-pi/);
	});

	it("requires an explicit system Pi executable", async () => {
		const dir = await tempRoot("pixip-backend-");
		const result = await cli(["daemon", "--data-dir", dir, "--port", "0", "--use-system-pi"]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /needs --pi <path> or PIXIP_PI/);
	});

	it("fails a missing host executable instead of degrading", async () => {
		const dir = await tempRoot("pixip-backend-");
		const result = await cli(["daemon", "--data-dir", dir, "--port", "0"], {
			PIXIP_PI_HOST: join(dir, "missing-host"),
		});
		assert.equal(result.code, 1);
		assert.match(result.stderr, /PIXIP_PI_HOST not found/);
	});
});

describe("pixip reload", () => {
	it("reloads assets and live children, then prints the report", async () => {
		const dir = await tempRoot("pixip-reload-");
		const { url, pid } = await daemon(
			dir,
			{ PIXIP_PI_HOST: HOST_FIXTURE, FAKE_HOST_LOG: join(dir, "host.jsonl") },
			{ system: false },
		);
		await createSession(url, dir);
		const result = await cli(["reload", "--data-dir", dir]);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /reloaded assets/);
		const health = await fetchHealth(url);
		assert.equal(health.reloads, 1);
		assert.ok(pidAlive(pid));
		const report = JSON.parse(await readFile(join(dir, "pixip.reload.json"), "utf8")) as Record<string, unknown>;
		assert.equal(report["ok"], true);
		assert.equal(report["status"], "ok");
		await cli(["stop", "--data-dir", dir]);
	});

	it("exits 1 and reports blockers while a session is busy", async () => {
		const dir = await tempRoot("pixip-reload-");
		const { url } = await daemon(dir, { FAKE_PI_IS_STREAMING: "1" });
		await createSession(url, dir);
		const result = await cli(["reload", "--data-dir", dir]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /reload refused:/);
		const health = await fetchHealth(url);
		assert.equal(health.reloads, 0);
		await cli(["stop", "--data-dir", dir]);
	});

	it("is user-only from inside an agent", async () => {
		const dir = await tempRoot("pixip-reload-");
		const result = await cli(["reload", "--data-dir", dir], { PIXIP_INSIDE: "1" });
		assert.equal(result.code, 2);
		assert.equal(result.stderr.trim(), "reload is user-only, please ask your user to run the /reload command");
	});

	it("exits 1 when no daemon is running", async () => {
		const dir = await tempRoot("pixip-reload-");
		const result = await cli(["reload", "--data-dir", dir]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /not running/);
	});
});

describe("hard restart", () => {
	it("refuses while busy, times out with --when-idle and replaces with --force", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { url, pid } = await daemon(dir, { FAKE_PI_IS_STREAMING: "1" });
		await createSession(url, dir);

		const refused = await cli(["restart", "--data-dir", dir]);
		assert.equal(refused.code, 1);
		assert.match(refused.stderr, /refusing to restart while busy/);

		const timedOut = await cli(["restart", "--data-dir", dir, "--when-idle", "--timeout", "1"]);
		assert.equal(timedOut.code, 2);
		assert.match(timedOut.stderr, /still busy after 1s/);

		const forced = await cli(["restart", "--data-dir", dir, "--force"]);
		assert.equal(forced.code, 0, forced.stderr);
		assert.match(forced.stdout, /restarted/);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		assert.equal(pidAlive(pid), false);
		await cli(["stop", "--data-dir", dir]);
	});

	it("keeps a JSONL session listed across the restart", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const id = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
		const sessionsDir = join(dir, "sessions");
		await mkdir(sessionsDir, { recursive: true });
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id,
			cwd: dir,
			timestamp: "2026-11-21T00:00:00.000Z",
		});
		const entry = JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-11-21T00:00:01.000Z",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hi" }] },
		});
		await writeFile(join(sessionsDir, `2026-11-21T00-00-00-000Z_${id}.jsonl`), `${header}\n${entry}\n`);

		const { url } = await daemon(dir);
		const before = await fetchSessions(url);
		assert.equal(before.length, 1);
		assert.equal(before[0]?.id, id);

		const restarted = await cli(["restart", "--data-dir", dir]);
		assert.equal(restarted.code, 0, restarted.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state);
		const after = await fetchSessions(state.url);
		assert.equal(after.length, 1);
		assert.equal(after[0]?.id, id);
		assert.equal(after[0]?.state, "stopped");
		await cli(["stop", "--data-dir", dir]);
	});

	it("announces a restart and reattaches the same logical session on reconnect", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const sessionId = "01a1fb3f-aaaa-7664-b952-f6673a2c7a8c";
		const entry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-11-21T00:00:01.000Z",
			message: { role: "user", timestamp: 111, content: [{ type: "text", text: "hi" }] },
		};
		const fakeEnv = {
			FAKE_PI_SESSION_ID: sessionId,
			FAKE_PI_NEW_SESSION_ID: sessionId,
			FAKE_PI_ENTRIES: JSON.stringify([entry]),
			FAKE_PI_LEAF: "m1",
		};
		const { url, pid } = await daemon(dir, fakeEnv);
		const created = await createSession(url, dir);
		const logicalId = String(created["logicalId"]);

		const ws = new WebSocket(`${url.replace(/^http/, "ws")}ws?session=${encodeURIComponent(sessionId)}`);
		const frames: Array<Record<string, unknown>> = [];
		ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
		await waitFor(() => frames.some((frame) => frame["t"] === "snapshot"), 10_000);
		const first = frames.find((frame) => frame["t"] === "snapshot");
		assert.equal((first?.["entries"] as unknown[]).length, 1);

		const restarted = await cli(["restart", "--data-dir", dir, "--force"], fakeEnv);
		assert.equal(restarted.code, 0, restarted.stderr);
		assert.ok(frames.some((frame) => frame["t"] === "restarting"));
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);

		// Reconnect with the durable cursor: the new daemon reattaches the same
		// logical session and the delta is empty, so the known entry is not painted
		// twice.
		const reopened = new WebSocket(
			`${state.url.replace(/^http/, "ws")}ws?session=${encodeURIComponent(sessionId)}&since=m1`,
		);
		const next: Array<Record<string, unknown>> = [];
		reopened.on("message", (data) => next.push(JSON.parse(String(data)) as Record<string, unknown>));
		await waitFor(() => next.some((frame) => frame["t"] === "snapshot"), 15_000);
		const snapshot = next.find((frame) => frame["t"] === "snapshot");
		assert.equal(snapshot?.["resume"], true);
		assert.equal((snapshot?.["session"] as Record<string, unknown>)["logicalId"], logicalId);
		assert.equal((snapshot?.["entries"] as unknown[]).length, 0);
		const sessions = await fetchSessions(state.url);
		assert.ok(sessions.some((session) => session.logicalId === logicalId));
		ws.close();
		reopened.close();
		await cli(["stop", "--data-dir", dir]);
	});

	it("does not leak the caller's Pi session env to children across a restart", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const log = join(dir, "fake-pi.log");
		const { pid } = await daemon(dir);
		// The CLI that triggers the restart carries the session identity of the Pi
		// shell that ran it. Neither the helper nor the new daemon may pass it on.
		const restarted = await cli(["restart", "--data-dir", dir, "--force"], {
			PI_SESSION_ID: "01a1fb3f-cccc-7664-b952-f6673a2c7a8c",
			PI_SESSION_FILE: "/sessions/some-caller.jsonl",
			FAKE_PI_LOG: log,
		});
		assert.equal(restarted.code, 0, restarted.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		const created = await createSession(state.url, dir);
		const logicalId = String(created["logicalId"]);

		const spawns: Array<Record<string, unknown>> = [];
		await waitFor(async () => {
			const text = await readFile(log, "utf8").catch(() => "");
			for (const line of text.split("\n").filter(Boolean)) {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record["type"] === "spawn") spawns.push(record);
			}
			return spawns.length > 0;
		}, 10_000);
		assert.equal(spawns[0]?.["piSessionId"], null);
		assert.equal(spawns[0]?.["piSessionFile"], null);
		assert.equal(spawns[0]?.["pixipSessionId"], logicalId);
		await cli(["stop", "--data-dir", dir]);
	});

	it("does the stop/start in a detached helper that survives its caller", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { pid } = await daemon(dir);
		// Start a foreground restart, wait until the helper has logged its first
		// line (it is alive and owns the stop/start), then kill the foreground.
		// The helper is in its own session, so the daemon still comes back.
		const child = spawn(process.execPath, [CLI, "restart", "--data-dir", dir], { stdio: "ignore" });
		await waitFor(async () => {
			const log = await readFile(join(dir, "pixip.log"), "utf8").catch(() => "");
			return log.includes("[restart helper]");
		}, 15_000);
		child.kill("SIGKILL");
		await waitFor(async () => {
			const state = await runningDaemon(dir);
			return Boolean(state && state.pid !== pid);
		}, 15_000);
		assert.equal(pidAlive(pid), false);
		await cli(["stop", "--data-dir", dir]);
	});

	it("exposes the helper directly with --detached", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { pid } = await daemon(dir);
		const replaced = await cli(["restart", "--detached", "--data-dir", dir]);
		assert.equal(replaced.code, 0, replaced.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		await cli(["stop", "--data-dir", dir]);
	});

	it("--when-idle does not wait for the calling session", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const { url, pid } = await daemon(dir, { FAKE_PI_IS_STREAMING: "1" });
		const created = await createSession(url, dir);
		const logicalId = String(created["logicalId"]);
		assert.ok(logicalId);
		const restarted = await cli(["restart", "--data-dir", dir, "--when-idle", "--timeout", "1"], {
			PIXIP_SESSION_ID: logicalId,
		});
		assert.equal(restarted.code, 0, restarted.stderr);
		const state = await readDaemonState(dir);
		assert.ok(state && state.pid !== pid);
		await cli(["stop", "--data-dir", dir]);
	});

	it("starts when nothing is running", async () => {
		const dir = await tempRoot("pixip-daemon-");
		const result = await cli(["restart", "--data-dir", dir, "--port", "0", "--use-system-pi", "--pi", FIXTURE]);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /listening on/);
		assert.ok(await runningDaemon(dir));
		await cli(["stop", "--data-dir", dir]);
	});
});

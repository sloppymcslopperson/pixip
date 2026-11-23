#!/usr/bin/env node
/**
 * Reconnect and create benchmark for a real `pi` child.
 *
 * Generates a bounded fixture (an ~11 MB session) in a temp data dir, starts a
 * daemon on an ephemeral port, then measures:
 *
 *   - switch: connect + bounded window, warm child (green/yellow)
 *   - resume: connect with the durable cursor, only the delta
 *   - create: tap New -> composer ready, alone
 *   - create: same, while another agent is streaming
 *
 * With PIXIP_CHROME set it also measures browser paint times for switch,
 * reload and create. Without it, socket timings still run and paint is skipped.
 * This is not part of `npm run check`: a 1 vCPU box is too noisy for a gate.
 *
 *   PIXIP_CHROME=/path/to/chrome node tools/reconnect-bench.mjs
 *   node tools/reconnect-bench.mjs --no-busy      # skip the live model prompt
 *   node tools/reconnect-bench.mjs --session <file> # use an existing JSONL
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import puppeteer from "puppeteer-core";
import WebSocket from "ws";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SESSION_ID = "01a20b00-0000-7000-8000-00000000b001";
const TARGET_MS = 250;
const PASS_MS = 500;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const chrome = process.env["PIXIP_CHROME"];
const busy = !flag("--no-busy");
const sessionPath = value("--session");

const log = (message) => console.error(message);

function delay(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

async function freePort() {
	const server = createServer();
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address();
	await new Promise((done) => server.close(done));
	return port;
}

function entry(index, text) {
	return {
		type: "message",
		id: `b${index}`,
		parentId: index === 0 ? null : `b${index - 1}`,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			timestamp: 1_700_000_000_000 + index,
			content: [{ type: "text", text }],
		},
	};
}

/** ~11 MB: many small turns plus a few large tool-result-shaped outputs. */
function fixtureEntries() {
	const items = [];
	for (let index = 0; index < 1200; index += 1) {
		const huge = index % 20 === 0 ? "x".repeat(160_000) : `turn ${index} ` + "y".repeat(1200);
		items.push(JSON.stringify(entry(index, huge)));
	}
	return items;
}

async function writeFixture(dir) {
	const sessions = join(dir, "sessions");
	await mkdir(sessions, { recursive: true });
	const path = join(sessions, `2026-11-21T00-00-00-000Z_${SESSION_ID}.jsonl`);
	if (sessionPath) {
		const text = await readFile(sessionPath, "utf8");
		await writeFile(path, text);
		return { path, id: SESSION_ID };
	}
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		cwd: dir,
		timestamp: "2026-11-21T00:00:00.000Z",
	});
	const items = fixtureEntries();
	await writeFile(path, [header, ...items].join("\n") + "\n");
	return { path, id: SESSION_ID, bytes: items.reduce((sum, line) => sum + line.length + 1, 0) };
}

async function startDaemon(dir, port) {
	const child = spawn(
		process.execPath,
		[join(ROOT, "bin", "pixip.ts"), "--host", "127.0.0.1", "--port", String(port), "--data-dir", dir, "--idle-ms", "0"],
		{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	for (let attempt = 0; attempt < 100; attempt += 1) {
		await delay(100);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) return { child, output: () => output };
		} catch {
			// still booting
		}
	}
	child.kill("SIGTERM");
	throw new Error(`daemon did not start:\n${output}`);
}

/** Open a websocket and record the time to each interesting frame. */
function socketTimings(url) {
	return new Promise((resolve) => {
		const started = performance.now();
		const frames = [];
		const ws = new WebSocket(url);
		const finish = () => {
			ws.close();
			resolve(frames);
		};
		ws.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			frames.push({ at: performance.now() - started, frame, bytes: String(raw).length });
			// `commands` is the last frame of a normal attach. A synthetic fixture
			// may omit the optional footer, so never wait for it here.
			if (frame.t === "commands" || frame.t === "footer" || frame.t === "error") finish();
		});
		ws.on("error", finish);
		setTimeout(finish, 15_000);
	});
}

function first(frames, type) {
	return frames.find((item) => item.frame.t === type);
}

function cursorOf(frames) {
	const snapshot = [...frames].reverse().find((item) => item.frame.t === "snapshot");
	return snapshot?.frame.leafId ?? null;
}

function median(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	return sorted[Math.floor(sorted.length / 2)];
}

async function measureSocket(base, id) {
	const warm = [];
	const resume = [];
	for (let run = 0; run < 5; run += 1) {
		log(`  switch run ${run + 1}/5`);
		const frames = await socketTimings(`${base}ws?session=${id}`);
		warm.push(first(frames, "snapshot")?.at ?? null);
		const cursor = cursorOf(frames);
		log(`  resume run ${run + 1}/5 (cursor ${cursor})`);
		const delta = await socketTimings(`${base}ws?session=${id}&since=${cursor}`);
		resume.push(first(delta, "snapshot")?.at ?? null);
	}
	return { warm: median(warm), resume: median(resume) };
}

/** Park an attached socket, then resume it on the same WebSocket. */
function parkResumeOnce(base, id) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`${base}ws?session=${id}`);
		let attached = false;
		let cursor = null;
		let started = null;
		const finish = (value) => {
			ws.close();
			resolve(value);
		};
		ws.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === "snapshot") {
				cursor = frame.leafId ?? cursor;
				if (started !== null && frame.resume) finish(performance.now() - started);
				return;
			}
			if (frame.t === "commands" && !attached) {
				attached = true;
				started = performance.now();
				ws.send(JSON.stringify({ t: "park" }));
				ws.send(JSON.stringify({ t: "resume", since: cursor }));
			}
			if (frame.t === "error") finish(null);
		});
		ws.on("error", () => finish(null));
		setTimeout(() => finish(null), 15_000);
	});
}

async function measureParkResume(base, id) {
	const runs = [];
	for (let run = 0; run < 5; run += 1) {
		log(`  park/resume run ${run + 1}/5`);
		runs.push(await parkResumeOnce(base, id));
	}
	return median(runs);
}

async function createOnce(base) {
	const started = performance.now();
	const hello = await new Promise((resolve, reject) => {
		const ws = new WebSocket(`${base}ws`);
		ws.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === "hello") {
				resolve({ ws, frame });
			}
		});
		ws.on("error", reject);
	});
	const { ws } = hello;
	const opened = new Promise((resolve, reject) => {
		ws.on("message", (raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.t === "opened") resolve({ frame, at: performance.now() - started });
			if (frame.t === "error") reject(new Error(String(frame.message)));
		});
		ws.on("error", reject);
	});
	ws.send(JSON.stringify({ t: "create", cwd: ROOT }));
	const { frame, at } = await opened;
	const frames = await socketTimings(`${base}ws?session=${frame.session.id}`);
	const ready = first(frames, "snapshot")?.at ?? null;
	ws.send(JSON.stringify({ t: "stop" }));
	ws.close();
	return { opened: at, ready: at + (ready ?? 0) };
}

// ---------------------------------------------------------------- browser

async function browserRun(base, id, createBusy) {
	if (!chrome) return null;
	const browser = await puppeteer.launch({
		executablePath: chrome,
		headless: true,
		args: ["--no-sandbox", "--hide-scrollbars"],
	});
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
	const paint = () =>
		page.evaluate(
			() =>
				new Promise((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
				}),
		);
	const switchRuns = [];
	const parkRuns = [];
	const reloadRuns = [];
	for (let run = 0; run < 5; run += 1) {
		await page.goto(`${base}#s=${id}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForFunction(() => document.querySelector("#log .block"), { timeout: 30_000 });
		await page.goto(`${base}`, { waitUntil: "networkidle2", timeout: 30_000 });
		await page.waitForSelector(".group-rows .row-open", { timeout: 30_000 });
		const started = await page.evaluate(() => performance.now());
		await page.click(".group-rows .row-open");
		await page.waitForFunction(() => !document.querySelector("#session").hidden, { timeout: 30_000 });
		await page.waitForFunction(() => document.querySelector("#log .block"), { timeout: 30_000 });
		await paint();
		const elapsed = await page.evaluate((start) => performance.now() - start, started);
		switchRuns.push(elapsed);
	}
	for (let run = 0; run < 5; run += 1) {
		const started = performance.now();
		await page.goto(`${base}#s=${id}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForFunction(() => document.querySelector("#log .block"), { timeout: 30_000 });
		await paint();
		reloadRuns.push(performance.now() - started);
	}
	for (let run = 0; run < 5; run += 1) {
		await page.goto(`${base}#s=${id}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForFunction(() => document.querySelector("#log .block"), { timeout: 30_000 });
		await page.click("#back");
		await page.waitForSelector(".group-rows .row-open", { timeout: 30_000 });
		const started = await page.evaluate(() => performance.now());
		await page.click(".group-rows .row-open");
		await page.waitForFunction(() => !document.querySelector("#session").hidden, { timeout: 30_000 });
		await page.waitForFunction(() => document.querySelector("#log .block"), { timeout: 30_000 });
		await paint();
		parkRuns.push(await page.evaluate((start) => performance.now() - start, started));
	}
	let createRun = null;
	if (createBusy) {
		await page.goto(`${base}`, { waitUntil: "networkidle2", timeout: 30_000 });
		await page.waitForSelector(".group-new", { timeout: 30_000 });
		const started = await page.evaluate(() => performance.now());
		await page.click(".group-new");
		await page.waitForFunction(() => !document.querySelector("#session").hidden, { timeout: 60_000 });
		await page.waitForFunction(() => !document.querySelector("#input").disabled, { timeout: 60_000 });
		await paint();
		createRun = await page.evaluate((start) => performance.now() - start, started);
	}
	await browser.close();
	return { switch: median(switchRuns), park: median(parkRuns), reload: median(reloadRuns), create: createRun };
}

// -------------------------------------------------------------------- main

const dir = await mkdtemp(join(tmpdir(), "pixip-bench-"));
const fixture = await writeFixture(dir);
const port = await freePort();
const base = `http://127.0.0.1:${port}/`;
const daemon = await startDaemon(dir, port);
log(`daemon ${base} fixture ${fixture.path}`);

try {
	// First attach makes the session green/yellow for the switch numbers.
	log("attaching fixture...");
	await socketTimings(`${base}ws?session=${fixture.id}`);
	log("measuring switch/resume...");
	const socket = await measureSocket(base, fixture.id);
	log("measuring park/resume on one socket...");
	socket.parkResume = await measureParkResume(base, fixture.id);
	log("measuring create alone...");
	const createAlone = await createOnce(base);

	let createBusy = null;
	let busyObserved = false;
	if (busy) {
		// Make another session busy, then create while it streams.
		const prompt = new WebSocket(`${base}ws?session=${fixture.id}`);
		await new Promise((resolve, reject) => {
			prompt.on("open", resolve);
			prompt.on("error", reject);
		});
		prompt.send(JSON.stringify({ t: "prompt", text: "Reply with one word." }));
		const busyStarted = performance.now();
		while (performance.now() - busyStarted < 30_000) {
			const current = await fetch(`${base}api/sessions`).then((response) => response.json());
			const session = current.find((item) => item.id === fixture.id);
			if (session?.state === "busy") {
				busyObserved = true;
				break;
			}
			await delay(100);
		}
		if (!busyObserved) log("warning: the second agent never reported busy");
		createBusy = await createOnce(base);
		prompt.send(JSON.stringify({ t: "abort" }));
		prompt.close();
	}

	let browser = null;
	try {
		browser = await browserRun(base, fixture.id, busy);
	} catch (error) {
		log(`browser paint skipped: ${String(error?.message ?? error).split("\n")[0]}`);
	}
	const report = {
		fixture: { path: fixture.path, bytes: fixture.bytes ?? basename(fixture.path) },
		daemon: base,
		targetMs: TARGET_MS,
		passMs: PASS_MS,
		createTargetMs: 1500,
		socket,
		create: { alone: createAlone, busy: createBusy, busyObserved },
		browser,
	};
	console.log(JSON.stringify(report, null, 2));

	const verdict = (name, ms, pass) => {
		const state = ms === null ? "n/a" : ms <= TARGET_MS ? "target" : ms <= pass ? "pass" : "MISS";
		console.log(`${name.padEnd(22)} ${ms === null ? "n/a" : `${ms.toFixed(0)} ms`} ${state}`);
	};
	verdict("switch (window)", socket.warm, PASS_MS);
	verdict("resume (cursor)", socket.resume, PASS_MS);
	verdict("park/resume (socket)", socket.parkResume, PASS_MS);
	verdict("create alone", createAlone.ready, 1500);
	if (createBusy) verdict("create busy", createBusy.ready, 1500);
	if (browser) {
		verdict("browser switch", browser.switch, PASS_MS);
		verdict("browser park return", browser.park, PASS_MS);
		verdict("browser reload", browser.reload, PASS_MS);
		verdict("browser create", browser.create, 1500);
	}
	assert.ok(socket.warm !== null);
} finally {
	daemon.child.kill("SIGTERM");
	await rm(dir, { recursive: true, force: true });
}

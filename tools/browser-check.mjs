#!/usr/bin/env node
/**
 * Deterministic scripted browser checks for the main client flows.
 *
 * Boots an in-process fixture Hub/server on an ephemeral port with the real
 * `src/client` assets and the fake Pi fixture, then drives the dashboard,
 * composer, inline select surface, A2UI fixture panel and transcript windows at
 * 390x844 and 1280x900. Any page error, console error or horizontal overflow
 * fails the run.
 *
 *   PIXIP_CHROME=/path/to/chrome npm run check:browser
 *
 * Without PIXIP_CHROME the check prints a skip and exits 0, so `npm run check`
 * stays green on a box without Chromium. No production protocol or hub code is
 * involved: the fixture Hub is the same one `test/` uses.
 */
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

import { startServer } from "../src/server.ts";
import { cleanupRoots, fixtureRoot, hubFor, sessionFile, spawns, waitFor } from "../test/helpers/harness.ts";
import { fileURLToPath } from "node:url";

const executablePath = process.env["PIXIP_CHROME"];
if (!executablePath) {
	console.log("browser-check: PIXIP_CHROME is not set, skipping scripted browser checks");
	process.exit(0);
}

const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));
const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 1280, height: 900 },
];
const HISTORY_ENTRIES = 320;
const FLOW_TIMEOUT = 15_000;

function message(index, text = `history entry ${index}`) {
	return {
		type: "message",
		id: `h${index}`,
		parentId: index === 0 ? null : `h${index - 1}`,
		timestamp: "2026-11-21T00:00:01.000Z",
		message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
	};
}

const entries = Array.from({ length: HISTORY_ENTRIES }, (_, index) => message(index));

async function bootFixture() {
	const paths = await fixtureRoot("pixip-browser-", { flat: true });
	const { id } = await sessionFile(
		paths,
		entries.map((entry) => JSON.stringify(entry)),
		{ cwd: paths.dir },
	);
	const hub = hubFor(paths, {}, { FAKE_PI_ENTRIES: JSON.stringify(entries) });
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: CLIENT_DIR,
		log: () => {},
		dev: true,
	});
	return { paths, hub, server, sessionId: id };
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logHas(paths, predicate, label) {
	await waitFor(async () => (await spawns(paths)).some(predicate), FLOW_TIMEOUT).catch(() => {
		throw new Error(`timed out waiting for fake Pi log: ${label}`);
	});
}

async function waitForSession(page) {
	await page.waitForSelector("#session:not([hidden])", { timeout: FLOW_TIMEOUT });
	await page.waitForSelector("#composer:not([hidden])", { timeout: FLOW_TIMEOUT });
	await page.waitForFunction(() => document.querySelectorAll("#log .block").length > 0, { timeout: FLOW_TIMEOUT });
}

async function clickSurfaceButton(page, label) {
	const clicked = await page.evaluate((label) => {
		for (const button of document.querySelectorAll("#surface .surface-actions button")) {
			if ((button.textContent ?? "").trim() === label) {
				button.click();
				return true;
			}
		}
		return false;
	}, label);
	assert.equal(clicked, true, `surface button ${label} is present`);
}

async function waitSurface(page, visible = true) {
	await page.waitForFunction(
		(visible) => {
			const surface = document.querySelector("#surface");
			return Boolean(surface) && surface.hidden !== visible;
		},
		{ timeout: FLOW_TIMEOUT },
		visible,
	);
}

/** Click a button inside the A2UI Lit tree, which nests shadow roots. */
async function clickA2uiButton(page, label) {
	const clicked = await page.evaluate((label) => {
		const walk = (root) => {
			for (const element of root.querySelectorAll("*")) {
				if (element.shadowRoot && walk(element.shadowRoot)) return true;
				if (element.tagName === "BUTTON" && (element.textContent ?? "").trim() === label) {
					element.click();
					return true;
				}
			}
			return false;
		};
		return walk(document);
	}, label);
	assert.equal(clicked, true, `A2UI button ${label} is present`);
}

async function overflow(page) {
	return await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		innerWidth,
	}));
}

async function checkNoOverflow(page, label) {
	const { documentWidth, innerWidth } = await overflow(page);
	assert.ok(documentWidth <= innerWidth, `${label}: horizontal overflow (${documentWidth} > ${innerWidth})`);
}

async function runDashboardFlow(page, base, sessionId) {
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	const row = await page.waitForSelector(`.row[data-id="${sessionId}"]`, { timeout: FLOW_TIMEOUT });
	assert.ok(row, "dashboard lists the seeded session");
	await page.click(`.row[data-id="${sessionId}"] .row-open`);
	await waitForSession(page);
	await checkNoOverflow(page, "session open");
}

async function runComposerFlow(page, base, sessionId, paths, viewport) {
	const text = `browser check ${viewport.width}`;
	await page.goto(`${base}?flow=composer#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	await page.type("#input", text);
	await page.click("#send");
	await page.waitForFunction(
		(text) => [...document.querySelectorAll("#log .block")].some((node) => (node.textContent ?? "").includes(text)),
		{ timeout: FLOW_TIMEOUT },
		text,
	);
	await logHas(paths, (record) => record.type === "prompt" && record.text === text, `prompt ${text}`);
	await checkNoOverflow(page, "composer submit");
}

function selectRequest(id) {
	return {
		type: "extension_ui_request",
		id,
		method: "select",
		title: "Pick one",
		options: ["alpha", "beta"],
	};
}

async function inject(hub, sessionId, request) {
	const info = (await hub.list()).find((session) => session.id === sessionId);
	assert.ok(info, "live session is listed for injection");
	const raw = JSON.stringify(request);
	// Harness injection: the same record path a Pi child uses, without a prompt.
	hub.onRecord(info, raw, request);
}

async function runSelectFlow(page, base, sessionId, hub, paths) {
	await page.goto(`${base}?flow=select#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);

	await inject(hub, sessionId, selectRequest("browser-select-answer"));
	await waitSurface(page);
	await clickSurfaceButton(page, "alpha");
	await waitSurface(page, false);
	await logHas(
		paths,
		(record) =>
			record.type === "extension_ui_response" && record.id === "browser-select-answer" && record.value === "alpha",
		"select answer",
	);
	await checkNoOverflow(page, "select answer");

	await inject(hub, sessionId, selectRequest("browser-select-cancel"));
	await waitSurface(page);
	await page.click("#surface .surface-close");
	await waitSurface(page, false);
	await logHas(
		paths,
		(record) =>
			record.type === "extension_ui_response" && record.id === "browser-select-cancel" && record.cancelled === true,
		"select cancel",
	);

	await inject(hub, sessionId, selectRequest("browser-select-collapse"));
	await waitSurface(page);
	await page.click("#surface .surface-collapse");
	const collapsed = await page.evaluate(() => {
		const surface = document.querySelector("#surface");
		const collapse = document.querySelector("#surface .surface-collapse");
		return {
			collapsed: surface?.classList.contains("collapsed") === true,
			expanded: collapse?.getAttribute("aria-expanded") === "false",
		};
	});
	assert.equal(collapsed.collapsed, true, "select surface collapses");
	assert.equal(collapsed.expanded, true, "collapse control reports the collapsed state");
	await page.click("#surface .surface-collapse");
	await page.click("#surface .surface-close");
	await waitSurface(page, false);
	await checkNoOverflow(page, "select collapse");
}

async function runPanelFlow(page, base, sessionId) {
	const url = (step) => `${base}?panel=fixture&step=${step}#s=${sessionId}`;
	// The dev panel has no Pi request id, so assert the client half on the wire:
	// the surface sends the real A2UI action JSON (and cancelled for cancel).
	const cdp = await page.createCDPSession();
	await cdp.send("Network.enable");
	const sent = [];
	cdp.on("Network.webSocketFrameSent", ({ response }) => sent.push(String(response.payloadData ?? "")));
	try {
		await page.goto(url("answer"), { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
		await waitSurface(page);
		await page.waitForFunction(() => document.querySelector("a2ui-surface") !== null, { timeout: FLOW_TIMEOUT });
		await clickA2uiButton(page, "Submit");
		await waitSurface(page, false);
		await waitFor(
			() => sent.some((frame) => frame.includes('"t":"ui"') && frame.includes("submit") && frame.includes("fixture")),
			FLOW_TIMEOUT,
		).catch(() => {
			throw new Error("A2UI submit did not send the action JSON");
		});
		await checkNoOverflow(page, "A2UI answer");

		await page.goto(url("cancel"), { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
		await waitSurface(page);
		await page.waitForFunction(() => document.querySelector("a2ui-surface") !== null, { timeout: FLOW_TIMEOUT });
		await clickA2uiButton(page, "Cancel");
		await waitSurface(page, false);
		await waitFor(
			() => sent.some((frame) => frame.includes('"t":"ui"') && frame.includes("cancel")),
			FLOW_TIMEOUT,
		).catch(() => {
			throw new Error("A2UI cancel did not send its action");
		});
		await checkNoOverflow(page, "A2UI cancel");

		await page.goto(url("collapse"), { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
		await waitSurface(page);
		await page.waitForFunction(() => document.querySelector("a2ui-surface") !== null, { timeout: FLOW_TIMEOUT });
		await page.click("#surface .surface-collapse");
		const collapsed = await page.evaluate(
			() => document.querySelector("#surface")?.classList.contains("collapsed") === true,
		);
		assert.equal(collapsed, true, "A2UI panel collapses");
		await page.click("#surface .surface-collapse");
		await page.click("#surface .surface-close");
		await waitSurface(page, false);
		await checkNoOverflow(page, "A2UI collapse");
	} finally {
		await cdp.detach();
	}
}

async function transcriptDistance(page) {
	return await page.evaluate(() => {
		const log = document.querySelector("#log");
		return { distance: log.scrollHeight - log.scrollTop, bottom: log.scrollHeight - log.scrollTop - log.clientHeight };
	});
}

async function runHistoryFlow(page, base, sessionId) {
	await page.goto(`${base}?flow=history#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	const earlier = await page.waitForSelector("#log button.earlier", { timeout: FLOW_TIMEOUT });
	assert.ok(earlier, "load earlier is offered for a 320-entry session");

	// Click through the DOM: a Puppeteer click scrolls the button into view,
	// which would move the reading position before the prepend.
	await page.evaluate(() => {
		const log = document.querySelector("#log");
		log.scrollTop = log.scrollHeight;
	});
	const before = await transcriptDistance(page);
	const blocks = await page.evaluate(() => document.querySelectorAll("#log .block").length);
	await page.evaluate(() => document.querySelector("#log button.earlier").click());
	await page.waitForFunction(
		(blocks) => {
			const button = document.querySelector("#log button.earlier");
			return document.querySelectorAll("#log .block").length > blocks && (!button || button.disabled === false);
		},
		{ timeout: FLOW_TIMEOUT },
		blocks,
	);
	const after = await transcriptDistance(page);
	assert.equal(
		after.distance,
		before.distance,
		`load earlier preserves reading distance (${after.distance} != ${before.distance})`,
	);

	await page.evaluate(() => {
		document.querySelector("#log").scrollTop = 0;
	});
	await page.waitForSelector("#jump:not([hidden])", { timeout: FLOW_TIMEOUT });
	await page.evaluate(() => document.querySelector("#jump").click());
	// The jump control smooth-scrolls, so wait for the animation to settle.
	await page
		.waitForFunction(
			() => {
				const log = document.querySelector("#log");
				return log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
			},
			{ timeout: FLOW_TIMEOUT },
		)
		.catch(() => {});
	await page.waitForFunction(() => document.querySelector("#jump")?.hidden === true, { timeout: FLOW_TIMEOUT });
	const jumped = await transcriptDistance(page);
	// Chrome's smooth scroll settles one pixel short of the clamp; anything
	// larger is a real regression in the jump control.
	assert.ok(jumped.bottom >= 0 && jumped.bottom <= 1, `jump to newest reaches the bottom (${jumped.bottom} px away)`);
	await checkNoOverflow(page, "history windows");
}

async function runViewport(browser, base, fixture, viewport) {
	const page = await browser.newPage();
	const problems = [];
	page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() === "error") problems.push(`console: ${message.text()}`);
	});
	await page.setViewport({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.width < 600 ? 2 : 1,
		isMobile: viewport.width < 600,
		hasTouch: viewport.width < 600,
	});
	try {
		await runDashboardFlow(page, base, fixture.sessionId);
		await runComposerFlow(page, base, fixture.sessionId, fixture.paths, viewport);
		await runSelectFlow(page, base, fixture.sessionId, fixture.hub, fixture.paths);
		await runPanelFlow(page, base, fixture.sessionId);
		await runHistoryFlow(page, base, fixture.sessionId);
		await delay(50);
		assert.deepEqual(problems, [], `${viewport.width}px browser problems`);
	} finally {
		await page.close();
	}
}

async function main() {
	const fixture = await bootFixture();
	const browser = await puppeteer.launch({
		executablePath,
		headless: true,
		args: ["--no-sandbox", "--hide-scrollbars"],
	});
	try {
		for (const viewport of VIEWPORTS) await runViewport(browser, fixture.server.url, fixture, viewport);
	} finally {
		await browser.close();
		await fixture.server.close();
		await fixture.hub.shutdown();
		await cleanupRoots();
	}
	console.log(`browser-check: ${VIEWPORTS.length} viewports passed`);
}

try {
	await main();
} catch (error) {
	await cleanupRoots().catch(() => {});
	console.error(error);
	process.exit(1);
}

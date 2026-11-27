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
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
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
const run = promisify(execFile);
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
// A persisted user message carrying two ref tags. The tokens are filled once
// the hub knows the logical session id and the inbox id, so a reload exercises
// the snapshot path instead of the live one.
entries.push({
	type: "message",
	id: "h320",
	parentId: "h319",
	timestamp: "2026-11-21T00:00:02.000Z",
	message: {
		role: "user",
		content: [
			{
				type: "text",
				text: "persisted refs [pixip-ref=history/__LOGICAL__/h319] and [pixip-ref=history/__LOGICAL__/h318]",
			},
		],
	},
});

async function bootFixture() {
	const paths = await fixtureRoot("pixip-browser-", { flat: true });
	const { id } = await sessionFile(
		paths,
		entries.map((entry) => JSON.stringify(entry)),
		{ cwd: paths.dir },
	);
	const repo = `${paths.dir}/repo`;
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "pixip browser",
		GIT_AUTHOR_EMAIL: "pixip@example.invalid",
		GIT_COMMITTER_NAME: "pixip browser",
		GIT_COMMITTER_EMAIL: "pixip@example.invalid",
	};
	await mkdir(repo, { recursive: true });
	await run("git", ["-C", repo, "init", "-b", "main"], { env: gitEnv });
	await writeFile(`${repo}/file.txt`, "one\n");
	await run("git", ["-C", repo, "add", "file.txt"], { env: gitEnv });
	await run("git", ["-C", repo, "commit", "-m", "init"], { env: gitEnv });

	const hub = hubFor(paths, {}, { FAKE_PI_ENTRIES: JSON.stringify(entries), FAKE_PI_COMPACTION_DURATION_MS: "600" });
	const server = await startServer({
		host: "127.0.0.1",
		port: 0,
		hub,
		clientDir: CLIENT_DIR,
		log: () => {},
		dev: true,
	});
	const main = await hub.create(repo, "repo main");
	const peer = await hub.create(repo, "repo peer");
	const worktree = await hub.create(repo, "worktree agent", { branch: "ui-check" });
	await hub.inboxReport({ action: "new", name: "browser-report" });
	await hub.inboxReport({
		action: "write",
		name: "browser-report",
		html: "<!doctype html><html><body><h1>Browser report</h1><p>served safely</p></body></html>",
	});
	const inbox = await hub.inboxSend({
		subject: "browser inbox",
		body: "This message checks the inbox sheet, filters and sender row.",
		purpose: "attention-needed",
		sessionId: main.logicalId,
		reportName: "browser-report",
	});
	// The tag names the Pi session id, which the sessions frame carries, so a
	// deep link resolves it as a name-only chip once that frame arrives.
	await sessionFile(
		paths,
		entries.map((entry) => JSON.stringify(entry).replaceAll("__LOGICAL__", id).replaceAll("__INBOX__", inbox.id)),
		{ cwd: paths.dir },
	);
	return {
		paths,
		hub,
		server,
		sessionId: id,
		repo,
		mainId: main.id,
		mainLogicalId: main.logicalId,
		peerId: peer.id,
		peerLogicalId: peer.logicalId,
		inboxId: inbox.id,
		worktreeId: worktree.id,
		worktreeBranch: "ui-check",
	};
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

async function lastCopied(page) {
	return await page.evaluate(() => window.__copied?.at(-1) ?? null);
}

async function clickRefCopy(page, selector) {
	const clicked = await page.evaluate((selector) => {
		const button = document.querySelector(`${selector} [data-reftag-copy]`);
		button?.click();
		return Boolean(button);
	}, selector);
	assert.equal(clicked, true, `reftag copy button exists in ${selector}`);
}

async function blockTags(page, count = 2) {
	const tags = await page.evaluate(() =>
		[...document.querySelectorAll("#log [data-reftag]")].map((node) => node.dataset.reftag).filter(Boolean),
	);
	const unique = [...new Set(tags)];
	assert.ok(unique.length >= count, `at least ${count} addressable blocks: ${JSON.stringify(unique)}`);
	return unique.slice(0, count);
}

async function clickTagAction(page, tag, action) {
	const clicked = await page.evaluate(
		({ tag, action }) => {
			const block = [...document.querySelectorAll("#log [data-reftag]")].find((node) => node.dataset.reftag === tag);
			const button = block?.querySelector(`[data-reftag-${action}]`);
			button?.click();
			return Boolean(button);
		},
		{ tag, action },
	);
	assert.equal(clicked, true, `reftag ${action} exists for ${tag}`);
}

async function openBlockMenu(page, tag) {
	const clicked = await page.evaluate((tag) => {
		const block = [...document.querySelectorAll("#log [data-reftag]")].find((node) => node.dataset.reftag === tag);
		const button = block?.querySelector("[data-reftag-more]");
		button?.click();
		return Boolean(button);
	}, tag);
	assert.equal(clicked, true, `reftag menu exists for ${tag}`);
}

async function clickBlockMenu(page, label) {
	const clicked = await page.evaluate((label) => {
		const button = [...document.querySelectorAll("body > .reftag-menu button")].find(
			(node) => (node.textContent ?? "").trim() === label,
		);
		button?.click();
		return Boolean(button);
	}, label);
	assert.equal(clicked, true, `reftag menu item ${label} exists`);
}

async function runRefCopyFlow(page, base, sessionId, hub, paths) {
	await page.goto(`${base}?flow=reftags#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	await page.waitForSelector("#log [data-entry] .reftag-actions", { timeout: FLOW_TIMEOUT });
	const [firstTag, secondTag] = await blockTags(page);
	const beforeCopied = await page.evaluate(() => window.__copied.length);
	const beforeRecords = (await spawns(paths)).length;

	// The default action inserts the bare tag, never copies and never sends.
	await setComposer(page, "");
	await clickTagAction(page, firstTag, "insert");
	const emptyInsert = await page.evaluate(() => document.querySelector("#input").value);
	assert.equal(emptyInsert, firstTag, "an empty composer gets exactly the bare tag");
	assert.equal(await page.evaluate(() => window.__copied.length), beforeCopied, "inserting does not copy");
	assert.deepEqual(
		(await chipLabels(page)).map((chip) => chip.tag),
		[firstTag],
		"the inserted tag becomes a chip",
	);
	assert.equal(
		(await spawns(paths)).slice(beforeRecords).filter((record) => record.type === "prompt").length,
		0,
		"inserting never sends a prompt",
	);

	// A second insert appends on a new line; nothing else in the draft changes.
	await clickTagAction(page, secondTag, "insert");
	const twice = await page.evaluate(() => document.querySelector("#input").value);
	assert.equal(twice, `${firstTag}\n${secondTag}`, "the second tag goes on a new line");
	assert.equal((await chipLabels(page)).length, 2, "two distinct tags produce two chips");

	// A half-typed draft keeps its bytes and gains one new line plus the tag.
	await setComposer(page, "half draft");
	await clickTagAction(page, firstTag, "insert");
	assert.equal(
		await page.evaluate(() => document.querySelector("#input").value),
		`half draft\n${firstTag}`,
		"the draft is preserved apart from the appended tag",
	);
	assert.equal(
		(await spawns(paths)).slice(beforeRecords).filter((record) => record.type === "prompt").length,
		0,
		"no insert sends a prompt",
	);

	// The menu keeps both copy paths; `#` only inserts now.
	await openBlockMenu(page, firstTag);
	const labels = await page.evaluate(() =>
		[...document.querySelectorAll("body > .reftag-menu button")].map((button) => (button.textContent ?? "").trim()),
	);
	assert.ok(labels.includes("copy ref"), `menu has copy ref: ${JSON.stringify(labels)}`);
	assert.ok(labels.includes("copy with text"), `menu has copy with text: ${JSON.stringify(labels)}`);
	await clickBlockMenu(page, "copy ref");
	assert.equal(await lastCopied(page), firstTag, "copy ref copies just the tag");

	await openBlockMenu(page, firstTag);
	await clickBlockMenu(page, "copy with text");
	const withText = await lastCopied(page);
	assert.match(withText, /^\[pixip-ref=history\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\]\n\n> /);

	// Live block: insert works as soon as the message is painted. The fake Pi
	// does not echo prompts, so inject the same record a real child would emit.
	const stamp = 1735689600123;
	const text = "live ref insert";
	await inject(hub, sessionId, {
		type: "message_start",
		message: { role: "user", timestamp: stamp, content: [{ type: "text", text }] },
	});
	await page.waitForFunction(
		(text) =>
			[...document.querySelectorAll("#log .block.user[data-reftag]")].some((node) =>
				(node.textContent ?? "").includes(text),
			),
		{ timeout: FLOW_TIMEOUT },
		text,
	);
	const liveTag = await page.evaluate(() => {
		const block = [...document.querySelectorAll("#log .block.user[data-reftag]")].at(-1);
		return block?.dataset.reftag ?? "";
	});
	assert.match(liveTag, new RegExp(`/msg:user:${stamp}\\]$`));
	await setComposer(page, "");
	await clickTagAction(page, liveTag, "insert");
	assert.equal(await page.evaluate(() => document.querySelector("#input").value), liveTag);
	await page.waitForFunction(
		() => (document.querySelector("#input .reftag-chip-label")?.textContent ?? "").includes("live ref insert"),
		{ timeout: FLOW_TIMEOUT },
	);
	const liveChip = await chipLabels(page);
	assert.match(liveChip[0].label, /user/);
	assert.equal(liveChip[0].unresolved, false, "a live block tag resolves through the painted block");

	// Denied clipboard through the copy menu: the sheet opens with the tag
	// selected, exactly as before the default changed.
	await page.evaluate(() => {
		window.__clipboardDenied = true;
	});
	await openBlockMenu(page, firstTag);
	await clickBlockMenu(page, "copy ref");
	await page.waitForSelector("#sheet:not([hidden]) .sheet-text", { timeout: FLOW_TIMEOUT });
	const fallback = await page.evaluate(() => ({
		text: document.querySelector("#sheet .sheet-text")?.textContent ?? "",
		selected: window.getSelection()?.toString() ?? "",
	}));
	assert.match(fallback.text, /^\[pixip-ref=history\//);
	assert.equal(fallback.selected, fallback.text, "denied clipboard selects the tag in the sheet");
	await page.evaluate(() => {
		window.__clipboardDenied = false;
	});
	await page.click("#sheet .sheet-actions button:last-child");
	await page.waitForFunction(() => document.querySelector("#sheet")?.hidden === true, { timeout: FLOW_TIMEOUT });

	// With a blocking surface open the composer is gated: copy instead of insert.
	const beforeGateCopied = await page.evaluate(() => window.__copied.length);
	await inject(hub, sessionId, selectRequest("browser-insert-gated"));
	await waitSurface(page);
	await setComposer(page, "");
	await clickTagAction(page, firstTag, "insert");
	assert.equal(await page.evaluate(() => document.querySelector("#input").value), "", "a gated composer stays empty");
	assert.equal(
		await page.evaluate(() => window.__copied.length),
		beforeGateCopied + 1,
		"the gated action copies the tag",
	);
	assert.equal(await lastCopied(page), firstTag, "the fallback copies the same tag");
	assert.match(await page.evaluate(() => document.querySelector("#toast")?.textContent ?? ""), /composer unavailable/);
	await page.click("#surface .surface-close");
	await waitSurface(page, false);
	await checkNoOverflow(page, "reftag insert default");
}

async function viewportOf(page) {
	return (await page.evaluate(() => innerWidth)) + "px";
}

async function setComposer(page, text) {
	await page.evaluate((text) => {
		const input = document.querySelector("#input");
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}, text);
}

async function chipLabels(page) {
	return await page.evaluate(() =>
		[...document.querySelectorAll("#input .reftag-chip")].map((chip) => ({
			label: chip.querySelector(".reftag-chip-label")?.textContent ?? "",
			unresolved: chip.classList.contains("unresolved"),
			tag: chip.dataset.tag ?? "",
		})),
	);
}

async function runRefTagChipsFlow(page, base, sessionId, fixture) {
	// Arrive through the dashboard so the sessions frame (tier 3) is in memory,
	// the same path a phone user takes before opening a session.
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await page.waitForSelector(`.row[data-id="${sessionId}"]`, { timeout: FLOW_TIMEOUT });
	await page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] .row-open`)?.click(), sessionId);
	await waitForSession(page);
	const logical = await page.evaluate(async (id) => {
		const data = await (await fetch("/api/sessions")).json();
		const list = Array.isArray(data) ? data : (data.sessions ?? []);
		return list.find((session) => session.id === id || session.logicalId === id)?.logicalId ?? id;
	}, sessionId);
	const historyTag = `[pixip-ref=history/${logical}/h319]`;

	const beforeHistory = await page.evaluate(() => window.__inboxFetches);
	await setComposer(page, historyTag);
	await page.waitForFunction(
		() => (document.querySelector("#input .reftag-chip-label")?.textContent ?? "").includes("assistant"),
		{ timeout: FLOW_TIMEOUT },
	);
	const history = await chipLabels(page);
	assert.equal(history.length, 1, "one history tag yields one chip");
	assert.match(history[0].label, /assistant/);
	assert.match(history[0].label, /history entry 319/);
	assert.equal(await page.evaluate(() => window.__inboxFetches), beforeHistory, "history chips fetch nothing");

	// Every occurrence renders in place; malformed fragments stay literal text.
	await setComposer(page, `${historyTag} ${historyTag} [pixip-ref=history/only-two]`);
	assert.equal((await chipLabels(page)).length, 2, "duplicate tags each render inline");
	assert.equal(
		await page.evaluate(() => document.querySelector("#input").value.includes("[pixip-ref=history/only-two]")),
		true,
		"a malformed tag stays in the editor text",
	);

	// Inbox tag: one fetch for the connection, no matter how many keystrokes.
	const beforeInbox = await page.evaluate(() => window.__inboxFetches);
	await setComposer(page, "");
	await page.type("#input", `[pixip-ref=inbox/${fixture.inboxId}]`);
	await page.waitForFunction(
		() => (document.querySelector("#input .reftag-chip-label")?.textContent ?? "").includes("browser inbox"),
		{ timeout: FLOW_TIMEOUT },
	);
	const inbox = await chipLabels(page);
	assert.equal(inbox.length, 1);
	assert.match(inbox[0].label, /browser inbox/);
	assert.match(inbox[0].label, /attention needed/);
	const afterInbox = await page.evaluate(() => window.__inboxFetches);
	assert.equal(afterInbox - beforeInbox, 1, "the inbox list is fetched once for the connection");
	assert.equal(await page.evaluate(() => window.__inboxFetches), afterInbox, "keystrokes do not refetch");

	// A never-opened session is a name-only chip; an unknown inbox id is muted.
	const peerTag = `[pixip-ref=history/${fixture.peerLogicalId}/x]`;
	await setComposer(page, `${peerTag} [pixip-ref=inbox/does-not-exist]`);
	await page.waitForFunction(() => document.querySelectorAll("#input .reftag-chip").length === 2, {
		timeout: FLOW_TIMEOUT,
	});
	const mixed = await chipLabels(page);
	assert.equal(mixed[0].label, "repo peer", "a known but unopened session is name-only");
	assert.equal(mixed[0].unresolved, false);
	assert.equal(mixed[1].unresolved, true, "an unknown inbox id is unresolved");

	// Tap reveals ×; × removes only the token.
	await page.evaluate(() => document.querySelector("#input .reftag-chip")?.click());
	await page.waitForFunction(() => document.querySelector("#input .reftag-chip.open .reftag-chip-remove") !== null, {
		timeout: FLOW_TIMEOUT,
	});
	await page.evaluate(() => document.querySelector("#input .reftag-chip-remove")?.click());
	await page
		.waitForFunction((tag) => !document.querySelector("#input").value.includes(tag), { timeout: FLOW_TIMEOUT }, peerTag)
		.catch(() => {});

	// Synthetic paste (typing never fires a paste event).
	await setComposer(page, "");
	await page.evaluate((tag) => {
		const input = document.querySelector("#input");
		const data = new DataTransfer();
		data.setData("text/plain", tag);
		input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	}, historyTag);
	await page.waitForFunction(() => document.querySelector("#input .reftag-chip") !== null, {
		timeout: FLOW_TIMEOUT,
	});
	assert.equal((await chipLabels(page)).length, 1, "a pasted tag produces a chip");

	// A ref-only send keeps the raw tag in the prompt payload.
	await setComposer(page, historyTag);
	await page.click("#send");
	await page.waitForFunction(
		(tag) =>
			[...document.querySelectorAll("#log .block.user")].some(
				(node) =>
					(node.textContent ?? "").includes(tag) || node.querySelector(`.reftag-inline[data-reftag="${tag}"]`) !== null,
			),
		{ timeout: FLOW_TIMEOUT },
		historyTag,
	);
	assert.equal(
		await page.evaluate(() => document.querySelectorAll("#input .reftag-chip").length),
		0,
		"sending clears chips",
	);
	await logHas(fixture.paths, (record) => record.type === "prompt" && record.text === historyTag, "ref-only prompt");
	assert.equal(afterInbox - beforeInbox, 1, "no fetch at send");
	console.log(
		`browser-check reftag chips ${await viewportOf(page)}: inbox fetches ${afterInbox - beforeInbox}, history fetches 0, sent ${historyTag}`,
	);
	await checkNoOverflow(page, "composer reftag chips");
}

async function inlineChips(page, selector = ".block.user") {
	return await page.evaluate((selector) => {
		return [...document.querySelectorAll(`${selector} .reftag-inline`)].map((chip) => ({
			label: chip.querySelector(".reftag-inline-label")?.textContent ?? "",
			tag: chip.dataset.reftag ?? "",
		}));
	}, selector);
}

async function runTranscriptRefChipsFlow(page, base, sessionId, hub) {
	const historyTag = `[pixip-ref=history/${sessionId}/h319]`;
	const secondHistoryTag = `[pixip-ref=history/${sessionId}/h318]`;
	await page.goto(`${base}?flow=transcript-refs#s=${sessionId}`, {
		waitUntil: "domcontentloaded",
		timeout: FLOW_TIMEOUT,
	});
	await waitForSession(page);
	await page.waitForFunction(
		(tag) => document.querySelector(`#log .block.user .reftag-inline[data-reftag="${tag}"]`) !== null,
		{ timeout: FLOW_TIMEOUT },
		historyTag,
	);

	// Snapshot/reload path: both persisted refs become inline chips in place.
	const persisted = await inlineChips(page);
	assert.equal(persisted.length, 2, "the persisted message renders two inline chips");
	assert.ok(
		persisted.some((chip) => chip.tag === historyTag && /history entry 319/.test(chip.label)),
		`history chip label: ${JSON.stringify(persisted)}`,
	);
	assert.ok(
		persisted.some((chip) => chip.tag === secondHistoryTag && /history entry 318/.test(chip.label)),
		`second history chip label: ${JSON.stringify(persisted)}`,
	);
	const rawGone = await page.evaluate(
		(tags) => {
			const [tag, second] = tags;
			const block = [...document.querySelectorAll("#log .block.user")].find(
				(node) => node.querySelector(`.reftag-inline[data-reftag="${tag}"]`) !== null,
			);
			return {
				hasRawHistory: (block?.textContent ?? "").includes(tag),
				hasRawSecond: (block?.textContent ?? "").includes(second),
			};
		},
		[historyTag, secondHistoryTag],
	);
	assert.deepEqual(rawGone, { hasRawHistory: false, hasRawSecond: false }, "the raw brackets are not prose");

	// The message keeps its own copyable tag through the `copy ref` menu item.
	const blockTag = await page.evaluate((tag) => {
		const block = [...document.querySelectorAll("#log .block.user")].find(
			(node) => node.querySelector(`.reftag-inline[data-reftag="${tag}"]`) !== null,
		);
		return block?.dataset.reftag ?? "";
	}, historyTag);
	assert.ok(blockTag, "the persisted message has its own tag");
	await openBlockMenu(page, blockTag);
	await clickBlockMenu(page, "copy ref");
	assert.match(await lastCopied(page), /^\[pixip-ref=history\/[A-Za-z0-9._-]+\/h320\]$/);

	// An unresolved tag is escaped literal text, never a chip.
	await inject(hub, sessionId, {
		type: "message_start",
		message: {
			role: "user",
			timestamp: 1735689600999,
			content: [{ type: "text", text: "unknown [pixip-ref=inbox/does-not-exist]" }],
		},
	});
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll("#log .block.user")].some((node) => (node.textContent ?? "").includes("unknown ")),
		{ timeout: FLOW_TIMEOUT },
	);
	await page.waitForFunction(
		() => {
			const block = [...document.querySelectorAll("#log .block.user")].at(-1);
			return (block?.querySelectorAll(".reftag-token").length ?? 0) === 0;
		},
		{ timeout: FLOW_TIMEOUT },
	);
	const unresolved = await page.evaluate(() => {
		const block = [...document.querySelectorAll("#log .block.user")].at(-1);
		return {
			text: block?.textContent ?? "",
			chips: block?.querySelectorAll(".reftag-inline").length ?? -1,
		};
	});
	assert.match(unresolved.text, /unknown \[pixip-ref=inbox\/does-not-exist\]/);
	assert.equal(unresolved.chips, 0, "an unresolved tag does not become a chip");

	// Optimistic echo and Pi's own echo render the same chip label.
	await setComposer(page, historyTag);
	await page.click("#send");
	await page.waitForFunction(
		(tag) => {
			const block = [...document.querySelectorAll("#log .block.user")].at(-1);
			return block?.querySelector(`.reftag-inline[data-reftag="${tag}"]`) !== null;
		},
		{ timeout: FLOW_TIMEOUT },
		historyTag,
	);
	const optimistic = await page.evaluate(() => {
		const block = [...document.querySelectorAll("#log .block.user")].at(-1);
		const chip = block?.querySelector(".reftag-inline");
		return chip
			? { label: chip.querySelector(".reftag-inline-label")?.textContent ?? "", tag: chip.dataset.reftag ?? "" }
			: null;
	});
	await inject(hub, sessionId, {
		type: "message_start",
		message: {
			role: "user",
			timestamp: 1735689601777,
			content: [{ type: "text", text: historyTag }],
		},
	});
	await page.waitForFunction(
		(tag) => {
			const block = [...document.querySelectorAll("#log .block.user")].at(-1);
			return block?.dataset?.reftag !== undefined && block.querySelector(`.reftag-inline[data-reftag="${tag}"]`);
		},
		{ timeout: FLOW_TIMEOUT },
		historyTag,
	);
	const echoed = await page.evaluate(() => {
		const block = [...document.querySelectorAll("#log .block.user")].at(-1);
		const chip = block?.querySelector(".reftag-inline");
		return chip
			? { label: chip.querySelector(".reftag-inline-label")?.textContent ?? "", tag: chip.dataset.reftag ?? "" }
			: null;
	});
	assert.deepEqual(echoed, optimistic, "optimistic and Pi echoes render identically");

	// Reload repaints the persisted chips from the snapshot, not from the DOM.
	await page.reload({ waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	await page.waitForFunction(
		(tag) => document.querySelector(`#log .block.user .reftag-inline[data-reftag="${tag}"]`) !== null,
		{ timeout: FLOW_TIMEOUT },
		historyTag,
	);
	assert.equal((await inlineChips(page)).length, 2, "a reload keeps both chips");
	await checkNoOverflow(page, "transcript ref chips");
}

async function runDashboardFlow(page, base, sessionId) {
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	const row = await page.waitForSelector(`.row[data-id="${sessionId}"]`, { timeout: FLOW_TIMEOUT });
	assert.ok(row, "dashboard lists the seeded session");
	// Click in-page: a live `sessions` frame can replace the row between the
	// selector wait and a Puppeteer click, which would detach the handle.
	await page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] .row-open`)?.click(), sessionId);
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

async function chipStates(page) {
	return await page.evaluate(() =>
		[...document.querySelectorAll("#input .reftag-chip")].map((chip) => ({
			open: chip.classList.contains("open"),
			tag: chip.dataset.tag ?? "",
			unresolved: chip.classList.contains("unresolved"),
		})),
	);
}

async function tapChip(page) {
	await page.evaluate(() => document.querySelector("#input .reftag-chip")?.click());
}

async function waitChipTag(page, tag) {
	await page.waitForFunction(
		(tag) => document.querySelector("#input .reftag-chip")?.dataset.tag === tag,
		{ timeout: FLOW_TIMEOUT },
		tag,
	);
}

async function clickSheetLabel(page, label) {
	await page.evaluate((label) => {
		[...document.querySelectorAll("#sheet .sheet-actions button")]
			.find((button) => (button.textContent ?? "").trim() === label)
			?.click();
	}, label);
}

async function waitSheet(page, open = true) {
	await page.waitForFunction(
		(open) => (document.querySelector("#sheet")?.hidden === false) === open,
		{ timeout: FLOW_TIMEOUT },
		open,
	);
}

async function runRefChipNavigationFlow(page, base, sessionId, fixture) {
	await page.goto(`${base}?flow=refjump#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	const logical = await page.evaluate(async (id) => {
		const data = await (await fetch("/api/sessions")).json();
		const list = Array.isArray(data) ? data : (data.sessions ?? []);
		return list.find((session) => session.id === id || session.logicalId === id)?.logicalId ?? id;
	}, sessionId);
	const historyTag = `[pixip-ref=history/${logical}/h319]`;

	// First tap only exposes × and primes; it never navigates or opens a sheet.
	await setComposer(page, historyTag);
	await waitChipTag(page, historyTag);
	await page.waitForFunction(() => document.querySelector("#input .reftag-chip:not(.unresolved)") !== null, {
		timeout: FLOW_TIMEOUT,
	});
	const startHash = await page.evaluate(() => location.hash);
	await tapChip(page);
	assert.equal(await page.evaluate(() => document.querySelector("#sheet")?.hidden), true, "first tap opens no dialog");
	assert.deepEqual(
		(await chipStates(page)).map((chip) => chip.open),
		[true],
		"first tap exposes the remove button",
	);
	assert.equal(await page.evaluate(() => location.hash), startHash, "first tap does not navigate");

	// A click elsewhere drops the prime.
	await page.evaluate(() => document.querySelector("#bar")?.click());
	assert.equal((await chipStates(page))[0].open, false, "an outside click drops the prime");

	// Second tap on the same chip opens the confirmation sheet.
	await tapChip(page);
	await tapChip(page);
	await waitSheet(page);
	assert.equal(
		await page.evaluate(() => document.querySelector("#sheet .sheet-title")?.textContent),
		"jump to message?",
	);
	await clickSheetLabel(page, "Cancel");
	await waitSheet(page, false);
	assert.equal(await page.evaluate(() => location.hash), startHash, "cancel leaves the route alone");

	// Jump to an entry outside the initial window: it pages earlier, scrolls
	// and flashes without leaving the session.
	const olderTag = `[pixip-ref=history/${logical}/h0]`;
	await setComposer(page, olderTag);
	await waitChipTag(page, olderTag);
	await tapChip(page);
	await tapChip(page);
	await waitSheet(page);
	await clickSheetLabel(page, "Jump");
	await page.waitForFunction(
		() => document.querySelector('[data-entry="h0"]')?.classList.contains("reftag-flash") === true,
		{ timeout: 30_000 },
	);
	assert.equal(await page.evaluate(() => location.hash), startHash, "an in-session jump stays on the route");

	// × remains the only removal path.
	const beforeRemove = await page.evaluate(() => document.querySelector("#input").value);
	await tapChip(page);
	const remove = await page.evaluate(() => {
		const button = document.querySelector("#input .reftag-chip-remove");
		button?.click();
		return Boolean(button);
	});
	assert.equal(remove, true, "the primed chip exposes ×");
	await page.waitForFunction(
		(tag) => !document.querySelector("#input").value.includes(tag),
		{ timeout: FLOW_TIMEOUT },
		olderTag,
	);
	assert.equal(
		await page.evaluate(() => document.querySelector("#input").value),
		beforeRemove.replace(olderTag, ""),
		"× removes only the token",
	);

	// A missing entry pages to the start and reports it.
	const missingTag = `[pixip-ref=history/${logical}/does-not-exist]`;
	await setComposer(page, missingTag);
	await waitChipTag(page, missingTag);
	await tapChip(page);
	await tapChip(page);
	await waitSheet(page);
	await clickSheetLabel(page, "Jump");
	await page.waitForFunction(() => (document.querySelector("#toast")?.textContent ?? "") === "message not found", {
		timeout: 30_000,
	});

	// Inbox chips open the inbox page.
	const inboxTag = `[pixip-ref=inbox/${fixture.inboxId}]`;
	await setComposer(page, inboxTag);
	await waitChipTag(page, inboxTag);
	await page.waitForFunction(
		() => !(document.querySelector("#input .reftag-chip")?.classList.contains("unresolved") ?? true),
		{ timeout: FLOW_TIMEOUT },
	);
	await tapChip(page);
	await tapChip(page);
	await waitSheet(page);
	await clickSheetLabel(page, "Jump");
	await page.waitForSelector("#inbox-page:not([hidden])", { timeout: FLOW_TIMEOUT });

	// Cross-session history opens the owning session and targets the entry.
	// Arrive through the dashboard so the sessions frame is in memory.
	await page.goto(`${base}?flow=refjump-peer`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await page.waitForSelector(`.row[data-id="${sessionId}"]`, { timeout: FLOW_TIMEOUT });
	await page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] .row-open`)?.click(), sessionId);
	await waitForSession(page);
	const peer = await page.evaluate(async () => {
		const data = await (await fetch("/api/sessions")).json();
		const list = Array.isArray(data) ? data : (data.sessions ?? []);
		return list.find((session) => session.name === "repo peer") ?? null;
	});
	assert.ok(peer?.id && peer?.logicalId, "repo peer is listed");
	const peerTag = `[pixip-ref=history/${peer.logicalId}/h319]`;
	await setComposer(page, peerTag);
	await waitChipTag(page, peerTag);
	await page.waitForFunction(
		() => (document.querySelector("#input .reftag-chip-label")?.textContent ?? "").includes("repo peer"),
		{ timeout: FLOW_TIMEOUT },
	);
	await tapChip(page);
	await tapChip(page);
	await waitSheet(page);
	await clickSheetLabel(page, "Jump");
	await page.waitForFunction((id) => location.hash === `#s=${id}`, { timeout: FLOW_TIMEOUT }, peer.id);
	await page.waitForFunction(
		() => document.querySelector('[data-entry="h319"]')?.classList.contains("reftag-flash") === true,
		{ timeout: FLOW_TIMEOUT },
	);
	await checkNoOverflow(page, "reftag chip navigation");
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

async function runCompactionFlow(page, base, sessionId) {
	await page.goto(`${base}?flow=compaction#s=${sessionId}`, {
		waitUntil: "domcontentloaded",
		timeout: FLOW_TIMEOUT,
	});
	await waitForSession(page);
	await page.type("#input", "/compact keep the API notes");
	await page.click("#send");
	await page.waitForFunction(() => Boolean(document.querySelector("#log .compaction-indicator")), {
		timeout: FLOW_TIMEOUT,
	});
	assert.equal(await page.$eval("#input", (element) => element.disabled), true, "composer locks while compacting");
	await page.waitForFunction(() => Boolean(document.querySelector("#log details.compact-boundary")), {
		timeout: FLOW_TIMEOUT,
	});
	await page.waitForFunction(() => !document.querySelector("#log .compaction-indicator"), {
		timeout: FLOW_TIMEOUT,
	});
	assert.equal(await page.$eval("#input", (element) => !element.disabled), true, "composer unlocks after compaction");
	const label = await page.evaluate(
		() => [...document.querySelectorAll("#log details.compact-boundary > summary")].at(-1)?.textContent ?? "",
	);
	assert.match(label, /compacted/);
	assert.match(label, /100 → ~10/);
	await page.evaluate(() => [...document.querySelectorAll("#log details.compact-boundary > summary")].at(-1)?.click());
	const body = await page.evaluate(
		() => [...document.querySelectorAll("#log details.compact-boundary .meta-body")].at(-1)?.textContent ?? "",
	);
	assert.equal(body, "compacted");
	await checkNoOverflow(page, "compaction");
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

async function runParkFlow(page, base, sessionId) {
	// Count WebSocket constructions: returning to a parked session must not add one.
	await page.evaluateOnNewDocument(() => {
		const Native = window.WebSocket;
		window.__pixipSockets = 0;
		window.WebSocket = new Proxy(Native, {
			construct(target, args) {
				window.__pixipSockets += 1;
				return new target(...args);
			},
		});
	});
	await page.goto(`${base}#s=${sessionId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	const beforeBack = await page.evaluate(() => window.__pixipSockets);
	await page.evaluate(() => document.querySelector("#back").click());
	await page.waitForSelector(`.row[data-id="${sessionId}"] .row-open`, { timeout: FLOW_TIMEOUT });
	await page.waitForFunction(() => !document.querySelector("#list").hidden, { timeout: FLOW_TIMEOUT });
	const onList = await page.evaluate(() => window.__pixipSockets);
	assert.ok(onList > beforeBack, "leaving the session opens the dashboard socket");

	await page.evaluate((id) => document.querySelector(`.row[data-id="${id}"] .row-open`)?.click(), sessionId);
	await waitForSession(page);
	const backInSession = await page.evaluate(() => window.__pixipSockets);
	assert.equal(backInSession, onList, "returning to a parked session opens no new WebSocket");
	await checkNoOverflow(page, "parked session return");
}

async function waitGroup(page, repo) {
	await page.waitForFunction(
		(repo) =>
			[...document.querySelectorAll("#list section.group")].some(
				(section) => section.dataset.cwd === repo && section.querySelector(".group-toggle"),
			),
		{ timeout: FLOW_TIMEOUT },
		repo,
	);
}

async function openGroupMenu(page, selector) {
	await page.evaluate((selector) => document.querySelector(`${selector} .group-new`)?.click(), selector);
	await page.waitForSelector(`${selector} .group-menu`, { timeout: FLOW_TIMEOUT });
}

async function runWorktreeFlow(page, base, fixture) {
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitGroup(page, fixture.repo);

	const buttons = await page.evaluate(() => ({
		plain: Boolean(document.querySelector("#new-row .new-plain")),
		worktree: Boolean(document.querySelector("#new-row .new-worktree")),
	}));
	assert.deepEqual(buttons, { plain: true, worktree: true }, "top form has both new buttons");

	// Top form: "new with worktree" fetches the repo and opens the confirm step.
	await page.$eval(
		"#new-row input",
		(input, repo) => {
			input.value = repo;
		},
		fixture.repo,
	);
	await page.click("#new-row .new-worktree");
	await page.waitForSelector("#sheet .worktree-new", { timeout: FLOW_TIMEOUT });
	const form = await page.evaluate(() => ({
		slug: document.querySelector("#sheet .worktree-new input")?.value ?? "",
		preview: document.querySelector("#sheet .worktree-preview")?.textContent ?? "",
	}));
	assert.ok(form.slug.length > 0, "worktree slug is prefilled");
	assert.match(form.preview, /pixip_worktrees/, "confirm step names the resulting directory");
	assert.match(form.preview, /pixip\//, "confirm step names the resulting branch");
	await page.click("#sheet .sheet-actions button:last-child");
	await page.waitForFunction(() => document.querySelector("#sheet")?.hidden === true, { timeout: FLOW_TIMEOUT });

	const repoSelector = `#list section.group[data-cwd="${fixture.repo}"]`;
	const expanded = await page.$eval(
		`${repoSelector} .group-toggle`,
		(button) => button.getAttribute("aria-expanded") === "true",
	);
	if (!expanded)
		await page.evaluate((selector) => document.querySelector(selector)?.click(), `${repoSelector} .group-toggle`);
	await page.waitForSelector(`${repoSelector} section.worktree-group`, { timeout: FLOW_TIMEOUT });
	await openGroupMenu(page, repoSelector);
	const parentMenu = await page.evaluate(() =>
		[...document.querySelectorAll("#list .group-menu button")].map((button) => (button.textContent ?? "").trim()),
	);
	assert.deepEqual(parentMenu, ["new session", "new with worktree"], "parent group menu has both create actions");
	await page.keyboard.press("Escape");
	await page.evaluate(() => document.body.click());

	const worktreeSelector = "#list section.worktree-group";
	await openGroupMenu(page, worktreeSelector);
	const worktreeMenu = await page.evaluate(() =>
		[...document.querySelectorAll("#list .group-menu button")].map((button) => (button.textContent ?? "").trim()),
	);
	assert.deepEqual(worktreeMenu, ["new session", "delete worktree"], "worktree group menu has new and delete");
	await page.evaluate(() =>
		[...document.querySelectorAll("#list .group-menu button")]
			.find((button) => (button.textContent ?? "").includes("delete"))
			?.click(),
	);
	await page.waitForSelector("#sheet .worktree-list", { timeout: FLOW_TIMEOUT });
	const branchRows = await page.evaluate(() =>
		[...document.querySelectorAll("#sheet .worktree-branch")].map((node) => (node.textContent ?? "").trim()),
	);
	assert.ok(branchRows.includes(fixture.worktreeBranch), "manage sheet lists the target worktree");
	await page.evaluate(() =>
		[...document.querySelectorAll("#sheet .worktree-row button")]
			.find((button) => (button.textContent ?? "").trim() === "delete")
			?.click(),
	);
	await page.waitForSelector("#sheet .sheet-actions .danger", { timeout: FLOW_TIMEOUT });
	await page.click("#sheet .sheet-actions .danger");
	await page.waitForFunction(
		() => (document.querySelector("#sheet .sheet-title")?.textContent ?? "").includes("in use"),
		{ timeout: FLOW_TIMEOUT },
	);
	const refusal = await page.evaluate(() => document.querySelector("#sheet .sheet-text")?.textContent ?? "");
	assert.match(refusal, /still has sessions/, "referenced worktree delete is refused with its sessions");
	await page.click("#sheet .sheet-actions button:last-child");

	// Peer notice: two live agents in the same repo directory.
	await page.goto(`${base}#s=${fixture.mainId}`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await waitForSession(page);
	await page.waitForSelector("#log .peer-notice", { timeout: FLOW_TIMEOUT });
	const peerText = await page.evaluate(() => document.querySelector("#log .peer-notice")?.textContent ?? "");
	assert.match(peerText, /repo peer/, "peer notice names the other agent");
	await page.click("#log .peer-notice .peer-dismiss");
	await page.waitForFunction(() => document.querySelector("#log .peer-notice") === null, { timeout: FLOW_TIMEOUT });
	await checkNoOverflow(page, "worktree dashboard");
}

async function clickInboxChip(page, prefix) {
	const clicked = await page.evaluate((prefix) => {
		const chip = [...document.querySelectorAll("#inbox-page .inbox-chip")].find((button) =>
			(button.textContent ?? "").trim().startsWith(prefix),
		);
		chip?.click();
		return Boolean(chip);
	}, prefix);
	assert.equal(clicked, true, `inbox chip ${prefix} exists`);
}

async function runInboxFlow(page, base) {
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await page.waitForSelector("#inbox-bar:not([hidden])", { timeout: FLOW_TIMEOUT });
	await page.waitForFunction(
		() => (document.querySelector("#inbox-bar-subject")?.textContent ?? "") === "browser inbox",
		{ timeout: FLOW_TIMEOUT },
	);
	await page.evaluate(() => document.querySelector("#inbox-bar").click());
	await page.waitForSelector("#inbox-page:not([hidden]) .inbox-card", { timeout: FLOW_TIMEOUT });
	await checkNoOverflow(page, "inbox page");

	// Reading a message is expanding it; that marks it read without a reload.
	await page.evaluate(() => document.querySelector("#inbox-page .inbox-card-head").click());
	await page.waitForSelector("#inbox-page .inbox-body:not(.preview)", { timeout: FLOW_TIMEOUT });
	// Clicking the body (to select text) must not collapse the message again.
	await page.evaluate(() => document.querySelector("#inbox-page .inbox-body").click());
	assert.equal(
		await page.evaluate(() => document.querySelector("#inbox-page .inbox-body")?.classList.contains("preview")),
		false,
		"clicking the body leaves the message expanded",
	);
	await page.waitForFunction(
		() => (document.querySelector("#inbox-page .inbox-meta")?.textContent ?? "").includes("read"),
		{
			timeout: FLOW_TIMEOUT,
		},
	);
	// Collapsing and expanding re-render the list; the scroll offset must survive.
	const scrollStyle = await page.addStyleTag({
		content: "#inbox-page .inbox-list { max-height: 48px !important; }",
	});
	await page.evaluate(() => document.querySelector("#inbox-page .inbox-card-head").click());
	await page.waitForSelector("#inbox-page .inbox-body.preview", { timeout: FLOW_TIMEOUT });
	const beforeScroll = await page.evaluate(() => {
		const list = document.querySelector("#inbox-page .inbox-list");
		list.scrollTop = 30;
		return list.scrollTop;
	});
	assert.ok(beforeScroll > 0, "the inbox list can scroll with a short test viewport");
	await page.evaluate(() => document.querySelector("#inbox-page .inbox-body.preview").click());
	await page.waitForSelector("#inbox-page .inbox-body:not(.preview)", { timeout: FLOW_TIMEOUT });
	assert.equal(
		await page.evaluate(() => document.querySelector("#inbox-page .inbox-list")?.scrollTop),
		beforeScroll,
		"expanding from the preview keeps the inbox scroll position",
	);
	await scrollStyle.evaluate((node) => node.remove());
	await checkNoOverflow(page, "inbox message expanded");
	assert.equal(
		await page.evaluate(() => document.querySelector("#inbox-page .inbox-actions a.inbox-report")?.textContent ?? ""),
		"view report",
		"report message has a view-report link",
	);
	const reportTarget = page
		.browser()
		.waitForTarget((target) => target.url().includes("/reports/browser-report/"), { timeout: FLOW_TIMEOUT });
	await page.click("#inbox-page .inbox-actions a.inbox-report");
	const opened = await reportTarget;
	const reportPage = await opened.page();
	assert.ok(reportPage, "report opened in a new tab");
	await reportPage.waitForFunction(() => document.querySelector("h1")?.textContent === "Browser report", {
		timeout: FLOW_TIMEOUT,
	});
	await reportPage.close();

	await clickRefCopy(page, "#inbox-page .inbox-card");
	assert.match(await lastCopied(page), /^\[pixip-ref=inbox\/[A-Za-z0-9._-]+\]$/);

	// Archive hides the row; the archived toggle restores visibility.
	await page.evaluate(() =>
		[...document.querySelectorAll("#inbox-page .inbox-actions button")]
			.find((button) => (button.textContent ?? "").trim() === "archive")
			?.click(),
	);
	await page.waitForFunction(() => document.querySelector("#inbox-page .inbox-card") === null, {
		timeout: FLOW_TIMEOUT,
	});
	await clickInboxChip(page, "archived");
	await page.waitForSelector("#inbox-page .inbox-card", { timeout: FLOW_TIMEOUT });
	await page.evaluate(() =>
		[...document.querySelectorAll("#inbox-page .inbox-actions button")]
			.find((button) => (button.textContent ?? "").trim() === "restore")
			?.click(),
	);
	await page.waitForFunction(() => document.querySelector("#inbox-page .inbox-card") === null, {
		timeout: FLOW_TIMEOUT,
	});
	await clickInboxChip(page, "archived");
	await page.waitForSelector("#inbox-page .inbox-card", { timeout: FLOW_TIMEOUT });
	await clickRefCopy(page, "#inbox-page .inbox-card");
	assert.match(await lastCopied(page), /^\[pixip-ref=inbox\/[A-Za-z0-9._-]+\]$/);

	// Delete asks for confirmation; cancel keeps the message.
	await page.evaluate(() =>
		[...document.querySelectorAll("#inbox-page .inbox-actions button")]
			.find((button) => (button.textContent ?? "").trim() === "delete")
			?.click(),
	);
	await page.waitForFunction(
		() => (document.querySelector("#sheet .sheet-title")?.textContent ?? "").includes("delete message"),
		{ timeout: FLOW_TIMEOUT },
	);
	await page.click("#sheet .sheet-actions button:last-child");
	await page.waitForSelector("#inbox-page .inbox-card", { timeout: FLOW_TIMEOUT });
	await checkNoOverflow(page, "inbox archived filter");

	// A live sender opens its session and prefills the reply marker.
	await page.evaluate(() => document.querySelector("#inbox-page .inbox-sender")?.click());
	await waitForSession(page);
	const draft = await page.evaluate(() => document.querySelector("#input")?.value ?? "");
	assert.match(draft, /^\[inbox [0-9a-f]{8}\] $/, "sender tap prefills the inbox reply marker");

	// The inbox is a route, not a sheet: a direct load lands on its own page.
	await page.goto(`${base}?direct=inbox#inbox`, { waitUntil: "domcontentloaded", timeout: FLOW_TIMEOUT });
	await page.waitForSelector("#inbox-page:not([hidden]) .inbox-card", { timeout: FLOW_TIMEOUT });
	await page.waitForFunction(() => document.querySelector("#title")?.textContent === "inbox", {
		timeout: FLOW_TIMEOUT,
	});
	await checkNoOverflow(page, "direct inbox route");
}

async function runViewport(browser, base, fixture, viewport) {
	const page = await browser.newPage();
	const problems = [];
	page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		// A deliberate 4xx refusal (for example deleting a referenced worktree)
		// is an API result the flow asserts on, not an application error. Chrome
		// still logs every non-2xx fetch as a console error, so filter that exact
		// resource failure rather than hiding other console errors.
		const location = message.location()?.url ?? "";
		if (message.text().includes("Failed to load resource") && location.includes("/api/worktrees")) return;
		problems.push(`console: ${message.text()}`);
	});
	await page.evaluateOnNewDocument(() => {
		window.__copied = [];
		window.__clipboardDenied = false;
		const nativeFetch = window.fetch.bind(window);
		window.__inboxFetches = 0;
		window.fetch = (...args) => {
			const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
			if (String(url).includes("/api/inbox")) window.__inboxFetches += 1;
			return nativeFetch(...args);
		};
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: (text) => {
					if (window.__clipboardDenied) return Promise.reject(new Error("clipboard denied"));
					window.__copied.push(text);
					return Promise.resolve();
				},
			},
		});
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
		await runInboxFlow(page, base);
		await runWorktreeFlow(page, base, fixture);
		await runComposerFlow(page, base, fixture.sessionId, fixture.paths, viewport);
		await runRefTagChipsFlow(page, base, fixture.sessionId, fixture);
		await runRefCopyFlow(page, base, fixture.sessionId, fixture.hub, fixture.paths);
		await runRefChipNavigationFlow(page, base, fixture.sessionId, fixture);
		await runTranscriptRefChipsFlow(page, base, fixture.sessionId, fixture.hub);
		await runSelectFlow(page, base, fixture.sessionId, fixture.hub, fixture.paths);
		await runPanelFlow(page, base, fixture.sessionId);
		await runHistoryFlow(page, base, fixture.sessionId);
		await runCompactionFlow(page, base, fixture.sessionId);
		await runParkFlow(page, base, fixture.sessionId);
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

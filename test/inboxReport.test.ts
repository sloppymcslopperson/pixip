import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	InboxReportStore,
	MAX_REPORT_ASSET_BYTES,
	MAX_REPORT_BYTES,
	REPORT_DRAFT_TTL_MS,
	ReportError,
	validateHtml,
} from "../src/inboxReport.ts";
import { startServer } from "../src/server.ts";
import { cleanupRoots, exists, fixtureRoot, hubFor, tempRoot } from "./helpers/harness.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

function reportHtml(extra = "") {
	return `<!doctype html><html><head><title>Report</title><link rel="stylesheet" href="style.css"><style>body{background:url(chart.png)}</style></head><body><h1>Report</h1><img src="chart.png" alt="chart">${extra}<form><input placeholder="name"><button type="button">Go</button></form><a href="https://example.com">link</a></body></html>`;
}

async function storeFor(prefix = "pixip-report-") {
	const dir = await tempRoot(prefix);
	return { dir, root: join(dir, "reports"), store: new InboxReportStore({ root: join(dir, "reports") }) };
}

async function seeded(prefix = "pixip-report-") {
	const fixture = await storeFor(prefix);
	await fixture.store.create("demo");
	await writeFile(join(fixture.dir, "chart.png"), PNG);
	await fixture.store.addAsset("demo", join(fixture.dir, "chart.png"), "chart.png");
	await writeFile(join(fixture.dir, "style.css"), "body{background:url(chart.png);font-weight:600}");
	await fixture.store.addAsset("demo", join(fixture.dir, "style.css"), "style.css");
	await fixture.store.write("demo", reportHtml(), undefined);
	return fixture;
}

after(async () => {
	await cleanupRoots();
});

describe("report HTML validation", () => {
	it("accepts rich safe HTML with local assets, inert forms and navigation links", () => {
		const refs = validateHtml(reportHtml(), new Set(["chart.png", "style.css"]));
		assert.deepEqual([...refs].sort(), ["chart.png", "style.css"]);
	});

	it("rejects scripts, frames, event handlers and javascript URLs", () => {
		const assets = new Set(["chart.png", "style.css"]);
		assert.throws(() => validateHtml("<p onclick=x>hi</p>", assets), /event handler/);
		assert.throws(() => validateHtml("<script>alert(1)</script>", assets), /not allowed/);
		assert.throws(() => validateHtml("<iframe src=x></iframe>", assets), /not allowed/);
		assert.throws(() => validateHtml('<a href="javascript:alert(1)">x</a>', assets), /disallowed URL scheme/);
		assert.throws(() => validateHtml('<object data="x"></object>', assets), /not allowed/);
		assert.throws(() => validateHtml('<meta http-equiv="refresh" content="0">', assets), /http-equiv/);
	});

	it("rejects external resource loads but allows external navigation", () => {
		const assets = new Set(["chart.png", "style.css"]);
		assert.throws(() => validateHtml('<img src="https://example.com/a.png">', assets), /local report asset/);
		assert.throws(() => validateHtml('<img src="/a.png">', assets), /local report asset/);
		assert.throws(() => validateHtml('<img src="../a.png">', assets), /top-level report asset/);
		assert.throws(
			() => validateHtml('<link rel="stylesheet" href="https://example.com/a.css">', assets),
			/local report asset/,
		);
		assert.throws(() => validateHtml("<style>@import url('https://example.com/a.css');</style>", assets), /@import/);
		assert.throws(
			() => validateHtml("<style>body{background:url(https://example.com/a.png)}</style>", assets),
			/local report asset/,
		);
		assert.throws(() => validateHtml('<img src="missing.png">', assets), /missing asset/);
		assert.doesNotThrow(() => validateHtml('<a href="https://example.com">link</a>', assets));
	});

	it("rejects form submission and submit controls", () => {
		const assets = new Set<string>();
		assert.throws(() => validateHtml('<form action="/x"></form>', assets), /not allowed|display-only/);
		assert.throws(() => validateHtml('<input type="submit">', assets), /display-only/);
		assert.throws(() => validateHtml("<button>Go</button>", assets), /type="button"/);
		assert.doesNotThrow(() =>
			validateHtml('<form><input placeholder="x"><button type="button">Go</button></form>', assets),
		);
	});

	it("accepts inline SVG and rejects executable SVG content", () => {
		const assets = new Set<string>();
		assert.doesNotThrow(() =>
			validateHtml('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/><text x="1" y="9">hi</text></svg>', assets),
		);
		assert.throws(() => validateHtml("<svg><foreignObject></foreignObject></svg>", assets), /not allowed/);
		assert.throws(
			() => validateHtml('<svg><a href="javascript:alert(1)">x</a></svg>', assets),
			/disallowed URL scheme/,
		);
	});

	it("accepts small data images, including validated SVG", () => {
		const dataPng = `data:image/png;base64,${PNG.toString("base64")}`;
		assert.doesNotThrow(() => validateHtml(`<img src="${dataPng}">`, new Set()));
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>`;
		const dataSvg = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
		assert.doesNotThrow(() => validateHtml(`<img src="${dataSvg}">`, new Set()));
		const evil = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
		const evilData = `data:image/svg+xml;base64,${Buffer.from(evil).toString("base64")}`;
		assert.throws(() => validateHtml(`<img src="${evilData}">`, new Set()), /not allowed/);
	});
});

describe("report store", () => {
	it("creates, writes and reads a report with assets", async () => {
		const { store } = await seeded();
		const shown = await store.show("demo", []);
		assert.match(shown.html, /<h1>Report<\/h1>/);
		assert.deepEqual(shown.assets, ["chart.png", "style.css"]);
		assert.equal(shown.url, "/reports/demo/");
		assert.equal(await exists(join(store.rootDir, "demo", "index.html")), true);
	});

	it("requires the exact existing HTML before overwriting", async () => {
		const { store } = await seeded();
		await assert.rejects(() => store.write("demo", "<p>new</p>", undefined), /existingHtml is required/);
		await assert.rejects(() => store.write("demo", "<p>new</p>", "stale"), /report changed/);
		const current = (await store.show("demo", [])).html;
		await store.write("demo", "<p>new</p>", current);
		assert.equal((await store.show("demo", [])).html, "<p>new</p>");
	});

	it("fails duplicate names, unsafe names and over-size HTML", async () => {
		const { store } = await storeFor();
		await store.create("demo");
		await assert.rejects(() => store.create("demo"), /already exists/);
		await assert.rejects(() => store.create("../x"), /report name/);
		await assert.rejects(
			() => store.write("demo", "x".repeat(MAX_REPORT_BYTES + 1), undefined),
			/report HTML is too large/,
		);
	});

	it("adds and removes assets, refusing referenced removal", async () => {
		const { dir, store } = await seeded();
		await writeFile(join(dir, "extra.png"), PNG);
		await store.addAsset("demo", join(dir, "extra.png"), "extra.png");
		assert.ok((await store.show("demo", [])).assets.includes("extra.png"));
		await assert.rejects(() => store.removeAsset("demo", "chart.png"), /still referenced/);
		await store.write("demo", '<img src="chart.png" alt="">', (await store.show("demo", [])).html);
		await assert.rejects(() => store.removeAsset("demo", "chart.png"), /still referenced/);
		await store.write("demo", "<p>no image</p>", (await store.show("demo", [])).html);
		await store.removeAsset("demo", "style.css");
		await store.removeAsset("demo", "chart.png");
		assert.equal((await store.show("demo", [])).assets.includes("chart.png"), false);
	});

	it("rejects invalid or over-size assets", async () => {
		const { dir, store } = await storeFor();
		await store.create("demo");
		await writeFile(join(dir, "evil.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		await assert.rejects(() => store.addAsset("demo", join(dir, "evil.svg"), "evil.svg"), /not allowed/);
		await writeFile(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_REPORT_ASSET_BYTES)]));
		await assert.rejects(() => store.addAsset("demo", join(dir, "big.png"), "big.png"), /too large/);
		await writeFile(join(dir, "fake.png"), "not an image");
		await assert.rejects(() => store.addAsset("demo", join(dir, "fake.png"), "fake.png"), /not a valid/);
	});

	it("sweeps old drafts and immediately drops unreferenced published reports", async () => {
		let now = 0;
		const dir = await tempRoot("pixip-report-sweep-");
		const store = new InboxReportStore({ root: join(dir, "reports"), now: () => now });
		await store.create("draft");
		await store.create("published");
		await store.write("published", "<p>hi</p>", undefined);
		await store.markAttached("published");
		now = REPORT_DRAFT_TTL_MS + 1;
		assert.deepEqual((await store.retain(new Set())).sort(), ["draft", "published"]);
		assert.equal(await exists(join(store.rootDir, "draft")), false);
		assert.equal(await exists(join(store.rootDir, "published")), false);
	});
});

describe("report routes and inbox integration", () => {
	async function boot() {
		const paths = await fixtureRoot("pixip-report-routes-");
		const hub = hubFor(paths);
		const server = await startServer({
			host: "127.0.0.1",
			port: 0,
			hub,
			clientDir: paths.clientDir,
			log: () => {},
		});
		hub.setDaemonUrl(server.url);
		return { paths, hub, server };
	}

	it("serves the report directory, redirects and assets with a locked-down CSP", async () => {
		const { hub, server } = await boot();
		try {
			await hub.inboxReport({ action: "new", name: "demo" });
			const dir = await tempRoot("pixip-report-src-");
			await writeFile(join(dir, "chart.png"), PNG);
			await hub.inboxReport({ action: "add_asset", name: "demo", path: join(dir, "chart.png"), filename: "chart.png" });
			await hub.inboxReport({ action: "write", name: "demo", html: '<p>hello</p><img src="chart.png" alt="">' });

			const page = await fetch(new URL("reports/demo/", server.url));
			assert.equal(page.status, 200);
			assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
			assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'none'/);
			assert.match(await page.text(), /<p>hello<\/p>/);

			const direct = await fetch(new URL("reports/demo/index.html", server.url));
			assert.equal(direct.status, 200);
			assert.match(await direct.text(), /<p>hello<\/p>/);

			const redirect = await fetch(new URL("reports/demo", server.url), { redirect: "manual" });
			assert.equal(redirect.status, 301);
			assert.equal(redirect.headers.get("location"), "/reports/demo/");

			const image = await fetch(new URL("reports/demo/chart.png", server.url));
			assert.equal(image.status, 200);
			assert.equal(image.headers.get("content-type"), "image/png");
			assert.equal(image.headers.get("x-content-type-options"), "nosniff");

			assert.equal((await fetch(new URL("reports/demo/nope.png", server.url))).status, 404);
			assert.equal((await fetch(new URL("reports/nope/", server.url))).status, 404);
			assert.equal((await fetch(new URL("reports/demo/../index.html", server.url))).status, 404);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("attaches a report to messages and deletes it with the last referencing message", async () => {
		const { hub, server } = await boot();
		try {
			await hub.inboxReport({ action: "new", name: "demo" });
			await hub.inboxReport({ action: "write", name: "demo", html: "<p>hi</p>" });
			const first = await hub.inboxSend({
				subject: "first",
				body: "see report",
				purpose: "deliverable",
				reportName: "demo",
			});
			const second = await hub.inboxSend({
				subject: "second",
				body: "updated report",
				purpose: "deliverable",
				reportName: "demo",
			});
			assert.equal(first.reportName, "demo");
			const list = await hub.inboxList();
			assert.equal(list.messages.filter((message) => message.reportName === "demo").length, 2);
			const reportDir = join(hub.reportStore.rootDir, "demo");
			assert.equal(await exists(reportDir), true);

			await hub.inboxDelete(first.id);
			assert.equal(await exists(reportDir), true);
			await hub.inboxDelete(second.id);
			assert.equal(await exists(reportDir), false);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("fails a send when the report is missing or has no HTML", async () => {
		const { hub, server } = await boot();
		try {
			await assert.rejects(
				() => hub.inboxSend({ subject: "x", body: "y", purpose: "no-rush", reportName: "missing" }),
				ReportError,
			);
			await hub.inboxReport({ action: "new", name: "empty" });
			await assert.rejects(
				() => hub.inboxSend({ subject: "x", body: "y", purpose: "no-rush", reportName: "empty" }),
				/no HTML/,
			);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});

	it("serves reports without auth even when the inbox API has a token", async () => {
		const paths = await fixtureRoot("pixip-report-auth-");
		const hub = hubFor(paths, { inboxToken: "secret" });
		const server = await startServer({
			host: "127.0.0.1",
			port: 0,
			hub,
			clientDir: paths.clientDir,
			log: () => {},
		});
		try {
			await hub.inboxReport({ action: "new", name: "demo" });
			await hub.inboxReport({ action: "write", name: "demo", html: "<p>ok</p>" });
			assert.equal((await fetch(new URL("api/inbox", server.url))).status, 401);
			assert.equal((await fetch(new URL("reports/demo/", server.url))).status, 200);
		} finally {
			await server.close();
			await hub.shutdown();
		}
	});
});

describe("report store files", () => {
	it("writes index.html atomically and keeps the marker", async () => {
		const { store } = await seeded();
		const raw = JSON.parse(await readFile(join(store.rootDir, "demo", ".pixip-report.json"), "utf8")) as {
			name: string;
		};
		assert.equal(raw.name, "demo");
		assert.equal(await exists(join(store.rootDir, "demo", `index.html.${process.pid}.tmp`)), false);
	});
});

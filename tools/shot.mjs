#!/usr/bin/env node
/**
 * Screenshot + layout probe for the client, used to check the responsive
 * contract without a phone. Any Chromium/Chrome works:
 *
 *   PIXIP_CHROME=/path/to/chrome node tools/shot.mjs http://127.0.0.1:8137/ 390 844 out.png
 *
 * Prints the box model of the main regions (header, list, log, composer) so a
 * resize can be asserted instead of eyeballed, then writes the screenshot.
 */
import puppeteer from "puppeteer-core";

const [, , url = "http://127.0.0.1:8137/", wStr = "390", hStr = "844", out = "shot.png"] = process.argv;
const width = Number(wStr);
const height = Number(hStr);
const executablePath = process.env["PIXIP_CHROME"];
if (!executablePath) {
	console.error("set PIXIP_CHROME to a chrome/chromium/chrome-headless-shell binary");
	process.exit(2);
}

const browser = await puppeteer.launch({
	executablePath,
	headless: true,
	args: ["--no-sandbox", "--hide-scrollbars"],
});
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
	if (message.type() === "error") problems.push(`console: ${message.text()}`);
});

await page.setViewport({ width, height, deviceScaleFactor: width < 600 ? 2 : 1, isMobile: width < 600, hasTouch: width < 600 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
await new Promise((resolve) => setTimeout(resolve, 1200));

const metrics = await page.evaluate(() => {
	const rect = (selector) => {
		const element = document.querySelector(selector);
		if (!element) return null;
		const box = element.getBoundingClientRect();
		return {
			top: Math.round(box.top),
			left: Math.round(box.left),
			width: Math.round(box.width),
			height: Math.round(box.height),
			display: getComputedStyle(element).display,
			hidden: element.hidden,
		};
	};
	return {
		viewport: [innerWidth, innerHeight],
		bodyScrolls: document.body.scrollHeight > innerHeight,
		overflowX: document.documentElement.scrollWidth > innerWidth,
		bar: rect("#bar"),
		list: rect("#list"),
		log: rect("#log"),
		composer: rect("#composer"),
	};
});

await page.screenshot({ path: out });
console.log(JSON.stringify({ metrics, problems }, null, 2));
await browser.close();

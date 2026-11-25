#!/usr/bin/env node
/**
 * Render a design mockup SVG at several widths and crop the regions worth
 * looking at, plus report the design values that tend to drift while a mockup
 * is edited (colours, type sizes, stroke widths).
 *
 *   PIXIP_CHROME=/path/to/chrome node tools/svg-review.mjs ui_work/mocks/main.svg
 *   node tools/svg-review.mjs ui_work/mocks/main.svg --widths 360,390 --crops top,footer
 *   node tools/svg-review.mjs ui_work/mocks/main.svg --crop "rows:0,128,360,220"
 *
 * Output goes to `tmp/svg-review/<svg-name>/` (git-ignored): one PNG per width,
 * one crop PNG per region. `--metrics` prints palette, font sizes and stroke
 * widths as JSON; the same block is written to `metrics.json` beside the PNGs.
 *
 * Chrome on this box is unpacked rather than installed, so a headless run may
 * need its shared libraries on the loader path:
 *
 *   LD_LIBRARY_PATH=/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu \
 *   PIXIP_CHROME=/tmp/pixip-chrome/chrome-headless-shell/linux-158.0.8127.36/chrome-headless-shell-linux64/chrome-headless-shell \
 *   node tools/svg-review.mjs ui_work/mocks/paperape_brutal_mainscreen.svg
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_WIDTHS = [360, 390, 1280];
const DEFAULT_REGIONS = {
	top: [0, 0, 360, 130],
	banner: [0, 55, 360, 95],
	rows: [0, 128, 360, 220],
	footer: [0, 585, 360, 55],
};

function usage(message) {
	if (message) console.error(message);
	console.error(
		[
			"usage: node tools/svg-review.mjs <file.svg> [options]",
			"",
			"  --out <dir>            output directory (default tmp/svg-review/<name>)",
			"  --widths 360,390,1280  render widths in CSS px (default 360,390,1280)",
			"  --scale 2              device pixel ratio (default 2)",
			"  --crops top,banner     named crops, or 'all' (default) / 'none'",
			"  --crop name:x,y,w,h    one crop in SVG user units; repeatable",
			"  --metrics              print extracted colours, type sizes and strokes",
			"  --quiet                only print the output directory",
		].join("\n"),
	);
	process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
	const options = {
		file: undefined,
		out: undefined,
		widths: DEFAULT_WIDTHS,
		scale: 2,
		crops: Object.fromEntries(Object.entries(DEFAULT_REGIONS)),
		metrics: false,
		quiet: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined) usage(`${arg} needs a value`);
			index += 1;
			return value;
		};
		if (arg === "--help" || arg === "-h") usage();
		else if (arg === "--out") options.out = next();
		else if (arg === "--scale") options.scale = Number(next());
		else if (arg === "--metrics") options.metrics = true;
		else if (arg === "--quiet") options.quiet = true;
		else if (arg === "--widths") {
			options.widths = next()
				.split(",")
				.map((value) => Number(value.trim()))
				.filter((value) => Number.isFinite(value) && value > 0);
			if (options.widths.length === 0) usage("--widths needs at least one positive number");
		} else if (arg === "--crops") {
			const value = next();
			if (value === "none") options.crops = {};
			else if (value === "all") options.crops = { ...DEFAULT_REGIONS };
			else {
				options.crops = {};
				for (const name of value.split(",")) {
					const region = DEFAULT_REGIONS[name.trim()];
					if (!region) usage(`unknown crop "${name}"`);
					options.crops[name.trim()] = region;
				}
			}
		} else if (arg === "--crop") {
			const value = next();
			const [name, numbers] = value.split(":");
			const region = (numbers ?? "").split(",").map(Number);
			if (!name || region.length !== 4 || region.some((n) => !Number.isFinite(n))) {
				usage(`--crop needs name:x,y,width,height, got "${value}"`);
			}
			options.crops[name] = region;
		} else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
		else if (options.file) usage(`unexpected argument ${arg}`);
		else options.file = arg;
	}
	if (!options.file) usage("needs an SVG file");
	return options;
}

/** The SVG's user-unit box, so crops can be given in the mockup's own numbers. */
async function canvas(svgPath) {
	const text = await readFile(svgPath, "utf8");
	const viewBox = /viewBox="([^"]*)"/.exec(text)?.[1]?.trim().split(/[ ,]+/).map(Number);
	if (viewBox?.length === 4) return { width: viewBox[2], height: viewBox[3] };
	const width = Number(/<svg[^>]*\bwidth="([\d.]+)"/.exec(text)?.[1]);
	const height = Number(/<svg[^>]*\bheight="([\d.]+)"/.exec(text)?.[1]);
	if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
	throw new Error("cannot read a viewBox or width/height from the SVG");
}

function metrics(svgText) {
	const count = (values) => {
		const tally = {};
		for (const value of values) tally[value] = (tally[value] ?? 0) + 1;
		return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]));
	};
	const all = (pattern) => [...svgText.matchAll(pattern)].map((match) => match[1]);
	return {
		colors: count(all(/fill:(#[0-9a-fA-F]{3,8})/g).filter((value) => value !== "none")),
		strokes: count(all(/stroke:(#[0-9a-fA-F]{3,8})/g).filter((value) => value !== "none")),
		strokeWidths: count(all(/stroke-width:([\d.]+)/g)),
		fontSizes: count(all(/font-size:([\d.]+)/g)),
		fontWeights: count(all(/font-weight:([0-9a-z]+)/g)),
		fontFamilies: count(all(/font-family:([^;"]+)/g)),
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const executablePath = process.env["PIXIP_CHROME"];
	if (!executablePath) {
		console.error("svg-review: set PIXIP_CHROME to a chrome/chromium/chrome-headless-shell binary");
		process.exit(1);
	}
	const svgPath = resolve(options.file);
	const svgText = await readFile(svgPath, "utf8");
	const box = await canvas(svgPath);
	const name = basename(svgPath).replace(/\.svg$/i, "");
	const out = resolve(options.out ?? join(ROOT, "tmp", "svg-review", name));
	await mkdir(out, { recursive: true });

	const report = metrics(svgText);
	await writeFile(join(out, "metrics.json"), `${JSON.stringify(report, null, "\t")}\n`);
	if (options.metrics) console.log(JSON.stringify(report, null, "\t"));

	const browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox"] });
	const written = [];
	try {
		for (const width of options.widths) {
			const page = await browser.newPage();
			const height = Math.round((box.height / box.width) * width);
			await page.setViewport({ width, height, deviceScaleFactor: options.scale });
			await page.goto(pathToFileURL(svgPath).href, { waitUntil: "load" });
			// The mockup is authored at one width; stretch the root, not the page.
			await page.evaluate((next) => {
				const root = document.documentElement;
				root.style.width = `${next}px`;
				root.style.height = "auto";
				root.style.display = "block";
			}, width);
			const scale = width / box.width;
			const shots = [
				["full", { x: 0, y: 0, width, height }],
				...Object.entries(options.crops ?? {}).map(([region, [x, y, w, h]]) => [
					region,
					{ x: x * scale, y: y * scale, width: w * scale, height: h * scale },
				]),
			];
			for (const [suffix, clip] of shots) {
				const file = `${name}-${width}${suffix === "full" ? "" : `-${suffix}`}.png`;
				await page.screenshot({ path: join(out, file), clip });
				written.push(file);
			}
			await page.close();
		}
	} finally {
		await browser.close();
	}

	if (!options.quiet) {
		console.log(relative(process.cwd(), out) || ".");
		for (const file of written) console.log(`  ${file}`);
		console.log(`  metrics.json`);
	} else {
		console.log(out);
	}
}

await main();

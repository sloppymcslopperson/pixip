#!/usr/bin/env node
/**
 * Re-vendor lit-html for the design mockups in ui_work/.
 *
 *   node tools/vendor-lit-html.mjs                  # pinned version
 *   node tools/vendor-lit-html.mjs --version 3.3.4  # one-off bump
 *   node tools/vendor-lit-html.mjs --dest /tmp/lit  # somewhere else
 *
 * The output is gitignored: ui_work/vendor/lit-html/ is 240+ files of unmodified
 * upstream code, so only this script and ui_work/vendor/README.md are committed.
 * Run it after a fresh clone, or whenever the pinned version changes.
 *
 * Dev-only and zero-dependency: it shells out to `npm pack` and the system tar.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump this (and ui_work/vendor/README.md) to move to a new release. */
const LIT_HTML_VERSION = "3.3.3";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(`usage: node tools/vendor-lit-html.mjs [--version <v>] [--dest <dir>]

  --version <v>  lit-html version to fetch (default ${LIT_HTML_VERSION})
  --dest <dir>   output directory (default ui_work/vendor/lit-html)`);
	process.exit(0);
}
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = flag("version", LIT_HTML_VERSION);
const pkg = "lit-html";
const dest = resolve(flag("dest", join(root, "ui_work/vendor/lit-html")));

// `node/` is the SSR build: it imports node builtins and is never used in the
// browser, so it is the one part of the tarball that is not copied.
const SKIP = new Set(["node"]);

const run = (command, commandArgs, options = {}) => {
	const result = spawnSync(command, commandArgs, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		...options,
	});
	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? "");
		throw new Error(`${command} ${commandArgs.join(" ")} failed (exit ${result.status})`);
	}
	return result.stdout ?? "";
};

try {
	await main();
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

async function main() {
	const temp = await mkdtemp(join(tmpdir(), `vendor-${pkg}-`));
	try {
		await fetchInto(temp);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

async function fetchInto(temp) {
	console.log(`fetching ${pkg}@${version} via npm pack`);
	const packed = run("npm", ["pack", `${pkg}@${version}`, "--pack-destination", temp]).trim();
	const tarball = packed.split("\n").at(-1);
	if (!tarball) throw new Error("npm pack printed no tarball name");

	run("tar", ["-xzf", join(temp, tarball), "-C", temp]);
	const source = join(temp, "package");

	// Sanity check: never install something that is not the pinned package.
	const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	if (manifest.name !== pkg || manifest.version !== version) {
		throw new Error(`tarball is ${manifest.name}@${manifest.version}, expected ${pkg}@${version}`);
	}

	await rm(dest, { recursive: true, force: true });
	for (const entry of await readdir(source)) {
		if (SKIP.has(entry)) continue;
		await cp(join(source, entry), join(dest, entry), { recursive: true });
	}

	const files = await countFiles(dest);
	const size = (await totalSize(dest)) / 1024;
	console.log(`wrote ${dest}`);
	console.log(`  ${pkg}@${version}: ${files} files, ${size.toFixed(0)} KB (skipped: ${[...SKIP].join(", ")})`);
	if (version !== LIT_HTML_VERSION) {
		console.log(`  note: script pins ${LIT_HTML_VERSION}; update LIT_HTML_VERSION to ${version} to make it stick`);
	}
}

async function countFiles(dir) {
	let count = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
		else count += 1;
	}
	return count;
}

async function totalSize(dir) {
	let bytes = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		bytes += entry.isDirectory() ? await totalSize(path) : (await stat(path)).size;
	}
	return bytes;
}

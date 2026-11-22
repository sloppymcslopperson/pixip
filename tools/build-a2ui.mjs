#!/usr/bin/env node
/**
 * Rebuild the vendored A2UI renderer. Dev-only: the committed bundle in
 * src/client/vendor/ is what ships, so CI and the server never need a bundler.
 *
 *   node tools/build-a2ui.mjs
 *
 * esbuild is fetched through npx at the pinned version instead of being added
 * to the project, and the A2UI packages are pinned in devDependencies. Bump
 * both here, rerun, and update src/client/vendor/a2ui.README.md.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD_VERSION = "0.25.12";
const WEB_CORE_VERSION = "0.15.0";
const LIT_VERSION = "0.15.0";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, "src/client/vendor");
const outfile = join(vendorDir, "a2ui.esm.js");

await mkdir(vendorDir, { recursive: true });

const result = spawnSync(
	"npx",
	[
		"--yes",
		`esbuild@${ESBUILD_VERSION}`,
		join(root, "tools/a2ui-entry.js"),
		"--bundle",
		"--format=esm",
		"--minify",
		"--target=es2022",
		"--legal-comments=none",
		`--outfile=${outfile}`,
	],
	{ cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

await copyFile(join(root, "node_modules/@a2ui/web_core/LICENSE"), join(vendorDir, "a2ui.LICENSE"));

const { size } = await stat(outfile);
console.log(`wrote ${outfile} (${(size / 1024).toFixed(1)} KB)`);
console.log(`pinned @a2ui/web_core ${WEB_CORE_VERSION}, @a2ui/lit ${LIT_VERSION}, esbuild ${ESBUILD_VERSION}`);

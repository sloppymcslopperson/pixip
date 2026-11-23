#!/usr/bin/env node
/**
 * Client import-graph guard.
 *
 * Enforces the normalized client boundaries:
 * - no import cycles;
 * - nothing imports the composition root (`app.js`);
 * - feature modules may import same-cluster siblings, kernel/pure/shared
 *   modules, but never another feature cluster;
 * - only `app.js` and the protocol adapter `frames.js` may import a feature
 *   module at all, so protocol knowledge stays in one place.
 *
 * Parses static `import`/`export ... from` and dynamic `import()` with the
 * existing TypeScript compiler API (no bundler, no new dependency). `vendor/` is
 * ignored: the prebuilt A2UI bundle is not source we own.
 *
 *   node tools/check-client-imports.mjs [src/client]
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

/** The cluster map lives here and nowhere else; ARCHITECTURE.md documents it. */
export const CLUSTERS = {
	dashboard: ["dashboard", "dashboardApi", "dashboardList", "dashboardPicker", "dashboardSettings", "dashboardModel"],
	session: ["session", "sessionEffects", "sessionPlan"],
	composer: ["composer", "composerAttachments", "composerBash"],
};

const CLUSTER_OF = new Map(
	Object.entries(CLUSTERS).flatMap(([cluster, modules]) => modules.map((module) => [module, cluster])),
);

/** Modules allowed to import feature handlers: the adapter and the composition root. */
const FEATURE_IMPORTERS = new Set(["app", "frames"]);

const DEFAULT_CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));

function moduleId(clientDir, file) {
	return relative(clientDir, file).split(/[\\/]/).join("/").replace(/\.js$/, "");
}

/** Resolve a relative specifier to a module id inside the client tree. */
function resolveSpecifier(fromId, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = fromId.includes("/") ? posix.dirname(fromId) : ".";
	return posix.normalize(posix.join(base, specifier)).replace(/\.js$/, "").replace(/^\.\//, "");
}

function importsOf(id, code) {
	const imports = new Set();
	const source = ts.createSourceFile(`${id}.js`, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const add = (node) => {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const target = resolveSpecifier(id, node.text);
		if (target && !target.startsWith("vendor/")) imports.add(target);
	};
	const walk = (node) => {
		if (ts.isImportDeclaration(node)) add(node.moduleSpecifier);
		else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier);
		else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1
		) {
			add(node.arguments[0]);
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return imports;
}

/** Build and check a graph from `{ moduleId: source }`; exposed for the tests. */
export function analyzeSources(sources) {
	const graph = new Map();
	for (const [id, code] of Object.entries(sources)) graph.set(id, importsOf(id, code));
	return { graph, violations: findViolations(graph) };
}

function findViolations(graph) {
	const violations = [];

	for (const [from, targets] of graph) {
		if (from === "app") continue;
		if (targets.has("app")) violations.push(`${from} imports app.js (only app.js is the composition root)`);
	}

	for (const [from, targets] of graph) {
		if (FEATURE_IMPORTERS.has(from)) continue;
		for (const target of targets) {
			const targetCluster = CLUSTER_OF.get(target);
			if (!targetCluster) continue;
			const sourceCluster = CLUSTER_OF.get(from);
			if (sourceCluster === targetCluster) continue;
			if (sourceCluster) {
				violations.push(`${from} (${sourceCluster}) imports ${target} (${targetCluster}); use a configure callback`);
			} else {
				violations.push(`${from} imports feature module ${target}; only app.js/frames.js may do that`);
			}
		}
	}

	violations.push(...findCycles(graph));
	return [...new Set(violations)];
}

function findCycles(graph) {
	const cycles = [];
	const colors = new Map();
	const stack = [];

	const visit = (id) => {
		colors.set(id, "gray");
		stack.push(id);
		for (const target of graph.get(id) ?? []) {
			if (!graph.has(target)) continue;
			if (colors.get(target) === "gray") {
				const at = stack.indexOf(target);
				cycles.push(`cycle: ${[...stack.slice(at), target].join(" -> ")}`);
				continue;
			}
			if (!colors.has(target)) visit(target);
		}
		stack.pop();
		colors.set(id, "black");
	};

	for (const id of graph.keys()) if (!colors.has(id)) visit(id);
	return cycles;
}

async function collectSources(clientDir) {
	const sources = {};
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name === "vendor") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.name.endsWith(".js")) continue;
			sources[moduleId(clientDir, path)] = await readFile(path, "utf8");
		}
	};
	await walk(clientDir);
	return sources;
}

/** Check a real client directory; returns the graph and any violations. */
export async function checkClientImports(clientDir = DEFAULT_CLIENT_DIR) {
	return analyzeSources(await collectSources(clientDir));
}

async function main() {
	const clientDir = process.argv[2] ?? DEFAULT_CLIENT_DIR;
	const { graph, violations } = await checkClientImports(clientDir);
	if (violations.length > 0) {
		console.error(`client import guard: ${violations.length} violation(s) in ${clientDir}`);
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log(`client import guard: ok (${graph.size} modules)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

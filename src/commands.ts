/**
 * Command policy config: read, validate, merge, serve.
 *
 * The merge itself lives in the pure client module (`resolvePolicy` in
 * `src/client/commands.js`) so the hub and the browser cannot disagree. This file
 * only touches the disk and turns bad input into an error that names the file.
 *
 * Layers, most general first (a layer can only narrow):
 * 1. `<data-dir>/pixip.json`;
 * 2. `<session-cwd>/.pixip.json`;
 * 3. CLI flags (`--allow-command`, `--deny-command`, `--no-bash`).
 *
 * Shape: `{"commands": {"allow": [], "deny": [], "bash": true}}`. Names are bare
 * (`compact`, not `/compact`); unknown keys are reported through `log`, malformed
 * JSON (or a wrong type) is an error carrying the path.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeName, resolvePolicy } from "./client/commands.js";
import type { CommandPolicy } from "./wire.ts";

export interface CommandLayer {
	allow?: string[];
	deny?: string[];
	bash?: boolean;
}

export const COMMAND_CONFIG_NAME = "pixip.json";
export const PROJECT_COMMAND_CONFIG_NAME = ".pixip.json";

export interface ResolvePolicyInput {
	/** `<data-dir>`; the shared layer is `<data-dir>/pixip.json`. */
	dataDir: string;
	/** Session cwd; the project layer is `<cwd>/.pixip.json`. */
	cwd: string;
	/** CLI layer, from `--allow-command` / `--deny-command` / `--no-bash`. */
	cli?: CommandLayer;
	log: (message: string) => void;
}

/** One policy file, or `undefined` when it does not exist. */
export async function readCommandLayer(
	path: string,
	log: (message: string) => void,
): Promise<CommandLayer | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path}: invalid JSON (${(error as Error).message})`);
	}
	return validateCommandLayer(parsed, path, log);
}

/** Validate a parsed config document; throws with the file path on bad types. */
export function validateCommandLayer(raw: unknown, path: string, log: (message: string) => void): CommandLayer {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${path}: expected a JSON object`);
	}
	const document = raw as Record<string, unknown>;
	for (const key of Object.keys(document)) {
		if (key !== "commands") log(`${path}: ignoring unknown key "${key}"`);
	}
	const section = document["commands"];
	if (section === undefined) return {};
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		throw new Error(`${path}: "commands" must be an object`);
	}
	const commands = section as Record<string, unknown>;
	const layer: CommandLayer = {};
	for (const key of Object.keys(commands)) {
		if (!["allow", "deny", "bash"].includes(key)) log(`${path}: ignoring unknown key "commands.${key}"`);
	}
	for (const key of ["allow", "deny"] as const) {
		const value = commands[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) throw new Error(`${path}: "commands.${key}" must be an array of command names`);
		const names: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") throw new Error(`${path}: "commands.${key}" must contain only command names`);
			const name = normalizeName(item);
			if (name && !names.includes(name)) names.push(name);
		}
		layer[key] = names;
	}
	const bash = commands["bash"];
	if (bash !== undefined) {
		if (typeof bash !== "boolean") throw new Error(`${path}: "commands.bash" must be true or false`);
		layer.bash = bash;
	}
	return layer;
}

/**
 * Effective policy for one session. Read at attach (the hub caches it until the
 * session reattaches or a soft refresh re-resolves it), so editing a policy file
 * never changes a running turn under the user's feet.
 */
export async function resolveSessionPolicy(input: ResolvePolicyInput): Promise<CommandPolicy> {
	const layers: CommandLayer[] = [];
	const shared = await readCommandLayer(join(input.dataDir, COMMAND_CONFIG_NAME), input.log);
	if (shared) layers.push(shared);
	if (input.cwd) {
		const project = await readCommandLayer(join(input.cwd, PROJECT_COMMAND_CONFIG_NAME), input.log);
		if (project) layers.push(project);
	}
	if (input.cli) layers.push(input.cli);
	return resolvePolicy(layers);
}

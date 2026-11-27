/**
 * Environment for a Pi-speaking child of the hub or CLI.
 *
 * Pi exports its current session to the shell tools of the process that owns
 * it (`PI_SESSION_ID`, `PI_SESSION_FILE`). Those values describe the *caller*,
 * so a daemon restarted from inside a Pi session would hand every later child a
 * session that has nothing to do with it. Strip them at the seam; Pi sets its
 * own values for its own shell calls, and the hub keeps `PIXIP_SESSION_ID` as
 * the per-child key.
 *
 * The returned environment also carries a usable `XDG_RUNTIME_DIR`: helpers like
 * the browser tool refuse to run without one. An unset or foreign value falls
 * back to `~/.run`, created with mode 0700. Nothing is written to `process.env`;
 * only the spawned child sees the repaired value.
 *
 * Only session identity is removed. Provider auth, Pi config vars, PATH, and
 * proxy settings are inherited untouched, and an explicit `extra` value wins
 * over the inherited environment.
 */

import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE"] as const;

function ownedByCurrentUser(path: string): boolean {
	const uid = process.getuid?.();
	if (uid === undefined) return true;
	try {
		return statSync(path).uid === uid;
	} catch {
		return false;
	}
}

/** A runtime dir we own, falling back to `~/.run` without touching the parent env. */
function runtimeDir(base: NodeJS.ProcessEnv): string {
	const configured = base["XDG_RUNTIME_DIR"]?.trim();
	if (configured && ownedByCurrentUser(configured)) return configured;

	const home = base["HOME"]?.trim() || homedir();
	const dir = join(home, ".run");
	let stat;
	try {
		stat = statSync(dir);
	} catch {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		return dir;
	}
	if (!stat.isDirectory()) throw new Error(`${dir} exists but is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`${dir} is owned by uid ${stat.uid}, not ${uid}; refusing to use a foreign runtime dir`);
	}
	if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
	return dir;
}

export function spawnEnv(
	extra: Record<string, string | undefined> = {},
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of SESSION_KEYS) delete env[key];
	env["XDG_RUNTIME_DIR"] = runtimeDir(env);
	return { ...env, ...extra };
}

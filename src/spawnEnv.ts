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
 * Only session identity is removed. Provider auth, Pi config vars, PATH, and
 * proxy settings are inherited untouched, and an explicit `extra` value wins
 * over the inherited environment.
 */

const SESSION_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE"] as const;

export function spawnEnv(
	extra: Record<string, string | undefined> = {},
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of SESSION_KEYS) delete env[key];
	return { ...env, ...extra };
}

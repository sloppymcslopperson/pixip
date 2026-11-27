/**
 * Opt-in pause/resume steering around a forced restart or a paused reload.
 *
 * The gate names the sessions a force operation would interrupt. This module
 * turns those blockers into a persisted plan, sends the pause steering, waits a
 * bounded time for the sessions to settle, and sends one resume prompt for each
 * session that is still eligible afterwards. It never claims a pause was
 * acknowledged: the steering is advisory and a turn that keeps running simply
 * stays a blocker.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionInfo } from "../wire.ts";

export const PAUSE_PROMPT =
	"The user would like to reload the session. Please pause your work so that you can resume it once the reload is done.";
export const RESUME_PROMPT = "Reload is finished, please resume.";
/** File under `<data-dir>`; consumed by the daemon that replaces this one. */
export const PAUSE_FILE = "pixip.pause.json";
/** How long a pause request waits for its targets to leave the gate. */
export const PAUSE_WAIT_MS = 30_000;

/** One session the operation asked to pause. `id` is the child id at that time. */
export interface PauseTarget {
	id: string;
	logicalId: string;
	name?: string;
	state: string;
}

export interface PauseSet {
	at: string;
	sessions: PauseTarget[];
}

export interface PauseSkip {
	id: string;
	name?: string;
	reason: string;
}

export interface PauseResumeReport {
	at: string;
	resumed: string[];
	skipped: PauseSkip[];
}

/** A tiny seam so this module does not import the hub (and stays reloadable). */
export interface PauseHub {
	list(): Promise<SessionInfo[]>;
	steer(id: string, text: string): Promise<void>;
}

/** The gate blockers as resume targets, matched to the live session for its logical id. */
export function pauseTargets(
	blockers: Array<{ id: string; name?: string; reason: string }>,
	sessions: SessionInfo[],
): PauseTarget[] {
	const targets: PauseTarget[] = [];
	for (const blocker of blockers) {
		const session = sessions.find((candidate) => candidate.id === blocker.id || candidate.logicalId === blocker.id);
		const logicalId = session?.logicalId ?? blocker.id;
		if (targets.some((target) => target.logicalId === logicalId)) continue;
		targets.push({
			id: session?.id ?? blocker.id,
			logicalId,
			...((session?.name ?? blocker.name) ? { name: session?.name ?? blocker.name } : {}),
			state: session?.state ?? "unknown",
		});
	}
	return targets;
}

/** Persist the pause plan atomically; an empty plan removes the file. */
export async function writePauseSet(dataDir: string, sessions: PauseTarget[]): Promise<void> {
	const path = join(dataDir, PAUSE_FILE);
	if (sessions.length === 0) {
		await unlink(path).catch(() => {});
		return;
	}
	const temp = `${path}.${process.pid}.tmp`;
	await mkdir(dataDir, { recursive: true });
	await writeFile(temp, `${JSON.stringify({ at: new Date().toISOString(), sessions }, null, 2)}\n`);
	await rename(temp, path);
}

function normalizeTargets(raw: unknown): PauseTarget[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
		.map((entry) => ({
			id: typeof entry["id"] === "string" ? entry["id"] : "",
			logicalId: typeof entry["logicalId"] === "string" ? entry["logicalId"] : "",
			...(typeof entry["name"] === "string" && entry["name"] ? { name: entry["name"] } : {}),
			state: typeof entry["state"] === "string" ? entry["state"] : "unknown",
		}))
		.filter((entry) => entry.logicalId.length > 0);
}

/** Read and consume the pause plan: only the daemon that replaces the old one sees it. */
export async function takePauseSet(dataDir: string): Promise<PauseTarget[]> {
	const path = join(dataDir, PAUSE_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	await unlink(path).catch(() => {});
	try {
		const raw = JSON.parse(text) as { sessions?: unknown };
		return normalizeTargets(raw.sessions);
	} catch {
		return [];
	}
}

/** Send the pause steering to every target; failures are reported, not thrown. */
export async function steerPause(hub: PauseHub, targets: PauseTarget[]): Promise<PauseSkip[]> {
	const failed: PauseSkip[] = [];
	for (const target of targets) {
		try {
			await hub.steer(target.id, PAUSE_PROMPT);
		} catch (error) {
			failed.push({
				id: target.logicalId,
				...(target.name ? { name: target.name } : {}),
				reason: (error as Error).message,
			});
		}
	}
	return failed;
}

/**
 * Resume the targets that are still eligible: matched by logical id (a changed
 * logical id is a skip), live, and `idle`/`stopped` (a finished or errored
 * session gets no prompt).
 */
export async function resumePaused(hub: PauseHub, targets: PauseTarget[]): Promise<PauseResumeReport> {
	const sessions = await hub.list();
	const resumed: string[] = [];
	const skipped: PauseSkip[] = [];
	for (const target of targets) {
		const session = sessions.find(
			(candidate) => (candidate.logicalId ?? candidate.id) === target.logicalId || candidate.id === target.id,
		);
		const name = session?.name ?? target.name;
		if (!session) {
			skipped.push({ id: target.logicalId, ...(name ? { name } : {}), reason: "not live" });
			continue;
		}
		if (session.logicalId !== undefined && session.logicalId !== target.logicalId) {
			skipped.push({ id: target.logicalId, ...(name ? { name } : {}), reason: "logical id changed" });
			continue;
		}
		if (session.state !== "idle" && session.state !== "stopped") {
			skipped.push({ id: target.logicalId, ...(name ? { name } : {}), reason: session.state });
			continue;
		}
		try {
			await hub.steer(session.id, RESUME_PROMPT);
			resumed.push(name ?? target.logicalId);
		} catch (error) {
			skipped.push({ id: target.logicalId, ...(name ? { name } : {}), reason: (error as Error).message });
		}
	}
	return { at: new Date().toISOString(), resumed, skipped };
}

/** One-line report for the daemon log and the reload notice. */
export function formatPauseReport(report: PauseResumeReport): string {
	const parts: string[] = [];
	if (report.resumed.length > 0) parts.push(`resumed ${report.resumed.join(", ")}`);
	if (report.skipped.length > 0)
		parts.push(`skipped ${report.skipped.map((entry) => `${entry.name ?? entry.id} (${entry.reason})`).join(", ")}`);
	return parts.length > 0 ? `pause/resume: ${parts.join("; ")}` : "pause/resume: no sessions";
}

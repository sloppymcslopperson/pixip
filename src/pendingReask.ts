// Hub-owned lifetime for blocking extension UI requests and the recovery
// records for requests that timed out. Kept free of Hub state so the parsing and
// data-dir rules can be tested on their own.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** No browser attached: five hours, enough for an overnight break. */
export const PENDING_UI_GRACE_MS = 5 * 60 * 60_000;
/** A browser is attached: ten hours, so a full work day fits. */
export const PENDING_UI_OPEN_MS = 10 * 60 * 60_000;
/** How long the timeout prompt waits for the agent's YES/NO reply. */
export const REASK_REPLY_MS = 60_000;
/** Marks the follow-up prompt so tests and logs can identify it. */
export const REASK_PROMPT_MARKER = "[pixip pending-ui timeout]";

export interface PendingUiRecord {
	/** The original `extension_ui_request` id. */
	id: string;
	method: string;
	/** Pi session id at timeout time. */
	sessionId: string;
	/** Stable logical session id, used for the data-dir filename. */
	logicalId?: string;
	cwd: string;
	/** The extension request as Pi sent it, still re-issuable by the agent. */
	request: Record<string, unknown>;
	/** The original line, preserved verbatim. */
	raw: string;
	timedOutAt: string;
	timeoutMs: number;
	attached: boolean;
}

/** Shape sent to the browser; `raw` stays in the data dir. */
export interface ReaskRequest {
	id: string;
	method: string;
	request: Record<string, unknown>;
	timedOutAt: string;
	timeoutMs: number;
	attached: boolean;
}

const writes = new Map<string, Promise<void>>();

function safeKey(value: string): string {
	const clean = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
	return clean || "session";
}

export function pendingUiKey(session: { logicalId?: string; id: string }): string {
	return safeKey(session.logicalId ?? session.id);
}

export function pendingUiDir(dataDir: string): string {
	return join(dataDir, "pending-ui");
}

export function pendingUiFile(dataDir: string, key: string): string {
	return join(pendingUiDir(dataDir), `${safeKey(key)}.json`);
}

export function publicReask(record: PendingUiRecord): ReaskRequest {
	return {
		id: record.id,
		method: record.method,
		request: record.request,
		timedOutAt: record.timedOutAt,
		timeoutMs: record.timeoutMs,
		attached: record.attached,
	};
}

export async function readPendingReasks(dataDir: string, key: string): Promise<PendingUiRecord[]> {
	let text: string;
	try {
		text = await readFile(pendingUiFile(dataDir, key), "utf8");
	} catch {
		return [];
	}
	try {
		const raw = JSON.parse(text);
		if (!Array.isArray(raw)) return [];
		return raw.filter(isRecord);
	} catch {
		return [];
	}
}

export function addPendingReask(dataDir: string, key: string, record: PendingUiRecord): Promise<void> {
	return serialized(dataDir, key, async () => {
		const records = await readPendingReasks(dataDir, key);
		const next = records.filter((entry) => entry.id !== record.id);
		next.push(record);
		await writeRecords(dataDir, key, next);
	});
}

export function removePendingReask(dataDir: string, key: string, id: string): Promise<void> {
	return serialized(dataDir, key, async () => {
		const records = await readPendingReasks(dataDir, key);
		const next = records.filter((entry) => entry.id !== id);
		if (next.length === records.length) return;
		await writeRecords(dataDir, key, next);
	});
}

export async function clearPendingReasks(dataDir: string, key: string): Promise<void> {
	await serialized(dataDir, key, async () => {
		await rm(pendingUiFile(dataDir, key), { force: true });
	});
}

async function writeRecords(dataDir: string, key: string, records: PendingUiRecord[]): Promise<void> {
	if (records.length === 0) {
		await rm(pendingUiFile(dataDir, key), { force: true });
		return;
	}
	await mkdir(pendingUiDir(dataDir), { recursive: true });
	const target = pendingUiFile(dataDir, key);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`);
	await rename(temp, target);
}

function serialized(dataDir: string, key: string, task: () => Promise<void>): Promise<void> {
	const id = `${dataDir}\u0000${key}`;
	const previous = writes.get(id) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(task);
	writes.set(id, next);
	void next.finally(() => {
		if (writes.get(id) === next) writes.delete(id);
	});
	return next;
}

function isRecord(value: unknown): value is PendingUiRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<PendingUiRecord>;
	return (
		typeof record.id === "string" &&
		typeof record.method === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.raw === "string" &&
		!!record.request &&
		typeof record.request === "object" &&
		typeof record.timedOutAt === "string" &&
		typeof record.timeoutMs === "number" &&
		typeof record.attached === "boolean"
	);
}

/** `undefined` means the reply was not a clear yes/no; the caller defaults to yes. */
export function parseReaskReply(text: string): boolean | undefined {
	if (/\bno\b/i.test(text)) return false;
	if (/\byes\b/i.test(text)) return true;
	return undefined;
}

export function describeRequest(request: Record<string, unknown>): string {
	const method = typeof request.method === "string" ? request.method : "request";
	const title = typeof request.title === "string" ? request.title : "";
	const message = typeof request.message === "string" ? request.message : "";
	const payload = request.payload as { title?: unknown } | undefined;
	const payloadTitle = typeof payload?.title === "string" ? payload.title : "";
	const label = title || message || payloadTitle;
	return label ? `${method}: ${label}` : method;
}

/** The prompt sent at timeout: ask whether this should be offered on resume. */
export function timeoutQuestionPrompt(record: PendingUiRecord): string {
	return `${REASK_PROMPT_MARKER}
A blocking user input request timed out after ${formatDuration(record.timeoutMs)}.
It was ${describeRequest(record.request)}.
Should it be offered again when the session resumes? Reply YES or NO only.`;
}

/** The prompt sent when the user clicks re-ask on a stored record. */
export function reaskPrompt(record: PendingUiRecord): string {
	const raw =
		record.raw.length > 16_000
			? `${record.raw.slice(0, 16_000)}\n[raw request truncated; full record is in the data dir]`
			: record.raw;
	return `${REASK_PROMPT_MARKER}
The user asked to retry a blocking request that timed out after ${formatDuration(record.timeoutMs)}.
Original request:
${raw}
Re-issue this same call now, with the same arguments, so the user can answer it.`;
}

function formatDuration(ms: number): string {
	const hours = ms / 3_600_000;
	if (hours >= 1) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
	const minutes = Math.round(ms / 60_000);
	return `${Math.max(1, minutes)} minutes`;
}

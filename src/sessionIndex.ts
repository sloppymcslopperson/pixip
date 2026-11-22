// Index and stored-session shapes shared by the Hub and its store modules.
import type { SessionInfo } from "./wire.ts";

/** Who owns the session name; a manual rename always wins over the auto label. */
export type NameSource = "auto" | "manual";

/**
 * One logical session, as recorded in `<data-dir>/sessions.json`.
 *
 * Pi allocates a new session id whenever a child is spawned (even when it is
 * reattached at an existing path), so the logical id is the stable handle: it
 * is passed to the child as `PIXIP_SESSION_ID` and tracks every Pi id the
 * session has run as. JSONL stays the source of truth for state, name and
 * activity; this record only keeps empty sessions visible and preserves the
 * mapping across restarts.
 */
export interface SessionIndexRecord {
	logicalId: string;
	/** Most recent Pi session id. */
	piId: string;
	/** Every Pi session id this logical session has run as, oldest first. */
	piIds: string[];
	cwd: string;
	name?: string;
	/** Whether `name` came from the first-prompt label or a user rename. */
	nameSource?: NameSource;
	sessionFile?: string;
	createdAt: string;
}

/**
 * A session in the archive or trash after its JSONL files left the active store.
 * `files` remembers where each file came from so restore can put it back.
 */
export interface StoredSessionRecord extends SessionIndexRecord {
	storedAt: string;
	files: Array<{ original: string; stored: string }>;
}

/** Archive/trash row for the settings sheets. */
export interface StoredSessionInfo extends SessionInfo {
	archivedAt?: string;
	deletedAt?: string;
	expiresAt?: number;
}

export interface SessionHeader {
	id: string;
	cwd: string;
	timestamp: string;
	/** Display name from the first `session_info` entry, when one is early in the file. */
	name?: string;
}

/** A resolved logical session plus the JSONL files that belong to it. */
export interface SessionTarget {
	info: SessionInfo;
	record: SessionIndexRecord;
	files: string[];
}

/**
 * A subscriber gets the verbatim frame plus an optional coverage key describing
 * the entry the record belongs to. Pi's RPC events carry no entry id, so the key
 * is the only way a socket can tell "already in the snapshot" from "newer".
 */
export function normalizeRecord(raw: unknown, fallbackCwd: string): SessionIndexRecord[] {
	if (!raw || typeof raw !== "object") return [];
	const record = raw as Partial<SessionIndexRecord>;
	if (typeof record.logicalId !== "string" || typeof record.piId !== "string") return [];
	const piIds = Array.isArray(record.piIds) ? record.piIds.filter((id): id is string => typeof id === "string") : [];
	return [
		{
			logicalId: record.logicalId,
			piId: record.piId,
			piIds: piIds.includes(record.piId) ? piIds : [...piIds, record.piId],
			cwd: typeof record.cwd === "string" ? record.cwd : fallbackCwd,
			name: typeof record.name === "string" ? record.name : undefined,
			nameSource: record.nameSource === "auto" || record.nameSource === "manual" ? record.nameSource : undefined,
			sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
			createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
		},
	];
}

/** Archive/trash row shape for the settings sheets. */
export function storedInfo(record: StoredSessionRecord, kind: "archive" | "trash", graceMs: number): StoredSessionInfo {
	const at = Date.parse(record.storedAt) || 0;
	return {
		id: record.piId,
		logicalId: record.logicalId,
		cwd: record.cwd,
		name: record.name,
		state: "stopped",
		sessionFile: record.sessionFile,
		lastActivity: at,
		...(kind === "archive" ? { archivedAt: record.storedAt } : { deletedAt: record.storedAt, expiresAt: at + graceMs }),
	};
}

/** A directory/file component that cannot escape its parent. */
export function safeName(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "session");
	return cleaned.slice(0, 120) || "session";
}

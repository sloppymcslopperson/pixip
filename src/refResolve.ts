// Offline `pixip ref` resolution: the data dir is the only source, so the
// command works with the daemon stopped and never masks a broken JSONL read
// behind a REST route. The client grammar stays in `src/reftags.ts`.
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { InboxStore } from "./inbox.ts";
import type { InboxPurpose } from "./inbox.ts";
import { FULL_ENTRY_BYTES, WINDOW_BYTES, parseEntries, readFromEnd, transcriptEntries } from "./jsonl.ts";
import { messageKey, parseRefTag } from "./reftags.ts";
import type { RefTag } from "./reftags.ts";
import type { StoredSessionRecord } from "./sessionIndex.ts";
import type { SessionInfo } from "./wire.ts";

const run = promisify(execFile);

/** The 4 KB cap from the ticket; the note names what was left out. */
export const REF_TEXT_CHARS = 4096;

/** A safe refusal (unknown, archived-away, deleted) maps to exit 2. */
export class RefResolutionError extends Error {
	readonly exitCode = 2;
}

export interface RefSessionSummary {
	logicalId: string | null;
	name: string | null;
	cwd: string | null;
	branch: string | null;
	state: string | null;
	archived: boolean;
}

export interface RefSenderSummary {
	logicalId: string | null;
	name: string | null;
	cwd: string | null;
	branch: string | null;
}

export interface ResolvedRef {
	ok: true;
	kind: "history" | "inbox";
	tag: string;
	role: string | null;
	time: string | null;
	session: RefSessionSummary | null;
	entryId: string | null;
	messageKey: string | null;
	text: string;
	truncated: boolean;
	subject: string | null;
	purpose: InboxPurpose | null;
	sender: RefSenderSummary | null;
}

export interface HubLike {
	list(): Promise<SessionInfo[]>;
}

interface StoredMatch {
	record: StoredSessionRecord;
	file: string | undefined;
}

function isoTime(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value === "string" && value.trim()) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	return null;
}

async function branchOf(cwd: string | undefined): Promise<string | null> {
	if (!cwd) return null;
	try {
		const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 });
		const branch = stdout.trim();
		if (branch && branch !== "HEAD") return branch;
		const { stdout: sha } = await run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { timeout: 2000 });
		return sha.trim() || null;
	} catch {
		return null;
	}
}

function textBlocks(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function entryText(entry: unknown): string {
	const record = entry as { message?: Record<string, unknown>; summary?: unknown } | null;
	const message = record?.message;
	const text = textBlocks(message?.["content"]);
	if (text) return text;
	if (typeof message?.["command"] === "string") {
		const output = textBlocks(message["output"]);
		return output ? `${message["command"]}\n\n${output}` : message["command"];
	}
	if (typeof record?.summary === "string") return record.summary;
	return JSON.stringify(entry);
}

function capText(text: string): { text: string; truncated: boolean } {
	if (text.length <= REF_TEXT_CHARS) return { text, truncated: false };
	const omitted = text.length - REF_TEXT_CHARS;
	return {
		text: `${text.slice(0, REF_TEXT_CHARS)}\n… truncated (${omitted} characters omitted)`,
		truncated: true,
	};
}

async function readEntry(file: string, ref: RefTag & { kind: "history" }): Promise<unknown> {
	for (let budget = WINDOW_BYTES; ; budget *= 4) {
		const read = Math.min(budget, FULL_ENTRY_BYTES);
		let tail: { text: string; offset: number };
		try {
			tail = await readFromEnd(file, read);
		} catch {
			return undefined;
		}
		const entries = transcriptEntries(parseEntries(tail.text, { dropFirst: tail.offset > 0 }));
		if ("entry" in ref) {
			const found = entries.find((entry) => (entry as { id?: unknown })?.id === ref.entry);
			if (found) return found;
		} else {
			const key = messageKey({ role: ref.message.role, timestamp: ref.message.timestamp });
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				if (messageKey(entries[index] as Parameters<typeof messageKey>[0]) === key) return entries[index];
			}
		}
		if (tail.offset === 0 || read >= FULL_ENTRY_BYTES) return undefined;
	}
}

async function readStored(dataDir: string, kind: "archive" | "trash", id: string): Promise<StoredMatch | undefined> {
	const root = join(dataDir, kind);
	const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of dirs) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		let record: StoredSessionRecord;
		try {
			record = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as StoredSessionRecord;
		} catch {
			continue;
		}
		const ids = [record.logicalId, record.piId, ...(Array.isArray(record.piIds) ? record.piIds : [])];
		if (!ids.includes(id)) continue;
		const files = Array.isArray(record.files) ? record.files : [];
		const chosen =
			files.find((file) => file.original === record.sessionFile) ??
			files.find((file) => file.stored.endsWith(".jsonl"));
		const file = chosen ? (isAbsolute(chosen.stored) ? chosen.stored : join(dir, chosen.stored)) : record.sessionFile;
		return { record, file };
	}
	return undefined;
}

function sessionSummary(
	info: SessionInfo | undefined,
	record: StoredSessionRecord | undefined,
	branch: string | null,
	archived: boolean,
): RefSessionSummary {
	return {
		logicalId: info?.logicalId ?? record?.logicalId ?? null,
		name: info?.name ?? record?.name ?? null,
		cwd: info?.cwd ?? record?.cwd ?? null,
		branch: info?.branch ?? record?.worktree?.branch ?? branch,
		state: archived ? "stopped" : (info?.state ?? "stopped"),
		archived,
	};
}

async function resolveHistory(hub: HubLike, dataDir: string, ref: RefTag & { kind: "history" }): Promise<ResolvedRef> {
	const active = (await hub.list()).find((session) => session.logicalId === ref.session || session.id === ref.session);
	let record: StoredSessionRecord | undefined;
	let file = active?.sessionFile;
	let archived = false;
	let branch: string | null = active?.branch ?? null;

	if (!file) {
		const stored = await readStored(dataDir, "archive", ref.session);
		if (stored) {
			record = stored.record;
			file = stored.file;
			archived = true;
			branch = record.worktree?.branch ?? (await branchOf(record.cwd));
		}
	}
	if (!file) {
		const trashed = await readStored(dataDir, "trash", ref.session);
		if (trashed) {
			throw new RefResolutionError(`session ${ref.session} was deleted`);
		}
		throw new RefResolutionError(`unknown session ${ref.session}`);
	}

	const entry = await readEntry(file, ref);
	if (!entry) {
		const key = "entry" in ref ? ref.entry : messageKey({ role: ref.message.role, timestamp: ref.message.timestamp });
		throw new RefResolutionError(`unknown entry ${key} in session ${ref.session}`);
	}
	const recordEntry = entry as { id?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
	const message = recordEntry.message;
	const text = capText(entryText(entry));
	const session = sessionSummary(active, record, branch, archived);
	if (!session.cwd) session.cwd = record?.cwd ?? null;
	return {
		ok: true,
		kind: "history",
		tag: `[pixip-ref=history/${ref.session}/${"entry" in ref ? ref.entry : `msg:${ref.message.role}:${ref.message.timestamp}`}]`,
		role: typeof message?.["role"] === "string" ? message["role"] : null,
		time: isoTime(message?.["timestamp"] ?? recordEntry.timestamp),
		session,
		entryId: typeof recordEntry.id === "string" ? recordEntry.id : null,
		messageKey: messageKey(entry),
		text: text.text,
		truncated: text.truncated,
		subject: null,
		purpose: null,
		sender: null,
	};
}

async function resolveInbox(dataDir: string, ref: RefTag & { kind: "inbox" }): Promise<ResolvedRef> {
	const store = new InboxStore({ path: join(dataDir, "inbox.json") });
	const message = (await store.all()).find((item) => item.id === ref.id);
	if (!message) {
		const deleted = (await store.tombstones()).find((item) => item.id === ref.id);
		throw new RefResolutionError(deleted ? `inbox message ${ref.id} was deleted` : `unknown inbox message ${ref.id}`);
	}
	const text = capText(message.body);
	return {
		ok: true,
		kind: "inbox",
		tag: `[pixip-ref=inbox/${ref.id}]`,
		role: null,
		time: isoTime(message.createdAt),
		session: null,
		entryId: null,
		messageKey: null,
		text: text.text,
		truncated: text.truncated,
		subject: message.subject,
		purpose: message.purpose,
		sender: {
			logicalId: message.sender.logicalId ?? null,
			name: message.sender.name ?? null,
			cwd: message.sender.cwd ?? null,
			branch: message.sender.branch ?? null,
		},
	};
}

/** Resolve one parsed tag against the offline data dir. */
export async function resolveRef(hub: HubLike, dataDir: string, ref: RefTag): Promise<ResolvedRef> {
	return ref.kind === "inbox" ? await resolveInbox(dataDir, ref) : await resolveHistory(hub, dataDir, ref);
}

/** Format a resolved ref for people; `--json` uses `ResolvedRef` directly. */
export function formatRef(result: ResolvedRef): string {
	const lines: string[] = [`kind: ${result.kind}`];
	if (result.kind === "inbox") {
		lines.push(`subject: ${result.subject ?? ""}`, `purpose: ${result.purpose ?? ""}`);
		if (result.sender) {
			lines.push(`sender: ${result.sender.name ?? "unknown"} (${result.sender.logicalId ?? "unknown"})`);
		}
	} else {
		const name = result.session?.name || result.session?.logicalId || "unknown";
		lines.push(`session: ${name}${result.session?.archived ? " (archived)" : ""}`, `role: ${result.role ?? ""}`);
		if (result.entryId) lines.push(`entry: ${result.entryId}`);
	}
	lines.push(`time: ${result.time ?? ""}`);
	if (result.kind === "history") {
		lines.push(`cwd: ${result.session?.cwd ?? ""}`, `branch: ${result.session?.branch ?? ""}`);
	}
	if (result.truncated) lines.push("truncated: true");
	return `${lines.join("\n")}\n\n${result.text}`;
}

/** Parse a positional tag; a malformed value is a usage error (exit 1). */
export function parseRefArg(value: string): RefTag {
	const ref = parseRefTag(value);
	if (ref?.kind === "inbox" && typeof ref.id === "string") return { kind: "inbox", id: ref.id };
	if (ref?.kind === "history" && typeof ref.session === "string") {
		if (typeof ref.entry === "string") return { kind: "history", session: ref.session, entry: ref.entry };
		if (ref.message) return { kind: "history", session: ref.session, message: ref.message };
	}
	throw new Error(`usage: pixip ref '[pixip-ref=history/<session>/<entry>]' or '[pixip-ref=inbox/<id>]'`);
}

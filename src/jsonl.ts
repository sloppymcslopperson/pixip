// Pure JSONL reading, windowing and truncation. No Hub state: the store and the
// live-session code both import these, and `node --test` can cover them alone.
import { copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Provisional / live transcript window: entries and raw line bytes. */
export const WINDOW_ENTRIES = 200;
export const WINDOW_BYTES = 256 * 1024;
/** Per-entry text cap in the provisional frame only. */
export const ENTRY_TEXT_LIMIT = 8 * 1024;

export async function moveFile(from: string, to: string): Promise<void> {
	await mkdir(dirname(to), { recursive: true });
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await copyFile(from, to);
		await unlink(from);
	}
}

/** Restore target; a path that is occupied gets a `.restored-N` suffix. */
export async function uniquePath(path: string): Promise<string> {
	let candidate = path;
	const ext = path.endsWith(".jsonl") ? ".jsonl" : "";
	const base = ext ? path.slice(0, -ext.length) : path;
	for (let suffix = 1; await pathExists(candidate); suffix += 1) {
		candidate = `${base}.restored-${suffix}${ext}`;
	}
	return candidate;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** First `maxBytes` of a file, decoded once (never a whole-session read). */
export async function readHead(path: string, maxBytes: number): Promise<{ text: string }> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return { text: buffer.subarray(0, bytesRead).toString("utf8") };
	} finally {
		await handle.close();
	}
}

/**
 * Last `maxBytes` of a file. `offset > 0` means the first returned line is a
 * partial one and must be dropped; the caller also uses it as "older data
 * exists before this window".
 */
export async function readFromEnd(
	path: string,
	maxBytes: number,
): Promise<{ text: string; offset: number; size: number }> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, maxBytes);
		const offset = size - length;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		return { text: buffer.subarray(0, read).toString("utf8"), offset, size };
	} finally {
		await handle.close();
	}
}

/**
 * JSONL text -> entries, oldest first. Jinxed input is skipped, never thrown:
 * a truncated final line, a partial first line (`dropFirst`) and unparsable
 * records all just fall out of the window.
 */
/** Internal map key while a child is booting and has no Pi id yet. */
export const SYMBOL_PENDING = "\u0000pending";

/**
 * Coverage key for a live record: the message identity Pi also stores on the
 * entry. Streaming updates belong to the assistant message that last started or
 * ended; tool executions belong to that same message (they carry its calls).
 */
export function coverageKey(
	target: { assistantTs?: number },
	record: { type?: string; message?: unknown },
): string | undefined {
	const message = record.message as { role?: unknown; timestamp?: unknown } | undefined;
	const role = typeof message?.role === "string" ? message.role : undefined;
	const stamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;
	switch (record.type) {
		case "message_start":
		case "message_end":
			if (!role || stamp === undefined) return undefined;
			if (role === "assistant") target.assistantTs = stamp;
			return `msg:${role}:${stamp}`;
		case "message_update":
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "turn_end":
			return target.assistantTs === undefined ? undefined : `msg:assistant:${target.assistantTs}`;
		default:
			return undefined;
	}
}

export function coverageKeys(entries: unknown[]): string[] {
	const keys: string[] = [];
	for (const entry of entries) {
		const message = (entry as { message?: { role?: unknown; timestamp?: unknown } } | null)?.message;
		if (!message || typeof message.role !== "string" || typeof message.timestamp !== "number") continue;
		keys.push(`msg:${message.role}:${message.timestamp}`);
	}
	return keys;
}

export function isBlockingUiMethod(method: string | undefined): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "panel";
}

/** Key used while a spawn is in flight, before `get_state` reports the real id. */

export function parseEntries(text: string, options: { maxEntries?: number; dropFirst?: boolean } = {}): unknown[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines.at(-1) === "") lines.pop();
	if (options.dropFirst && lines.length > 0) lines.shift();
	const window = typeof options.maxEntries === "number" ? lines.slice(-options.maxEntries) : lines;
	const entries: unknown[] = [];
	for (const line of window) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// Truncated or corrupt record: skip it rather than fail the paint.
		}
	}
	return entries;
}

/** Last non-empty `session_info` name in a run of JSONL lines. */
export function nameFromLines(lines: string[]): string | undefined {
	let name: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const record = JSON.parse(trimmed) as { type?: unknown; name?: unknown };
			if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
				name = record.name;
			}
		} catch {
			// Truncated or corrupt record: skip it, keep the name found so far.
		}
	}
	return name;
}

/** Drop the JSONL header record: only transcript entries belong in a window. */
export function transcriptEntries(entries: unknown[]): unknown[] {
	return entries.filter((entry) => (entry as { type?: unknown })?.type !== "session");
}

/** Provisional-view truncation: only the entries pushed before the child boots. */
export function truncateEntries(entries: unknown[], limit = ENTRY_TEXT_LIMIT): unknown[] {
	return entries.map((entry) => truncateEntry(entry, limit));
}

function truncateText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… truncated (${text.length - limit} more characters)`;
}

function truncateArgs(value: unknown, limit: number): unknown {
	if (typeof value === "string") return truncateText(value, limit);
	if (Array.isArray(value)) return value.map((item) => truncateArgs(item, limit));
	if (!value || typeof value !== "object") return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) copy[key] = truncateArgs(item, limit);
	return copy;
}

function truncateContent(content: unknown, limit: number): unknown {
	if (typeof content === "string") return truncateText(content, limit);
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const copy = { ...(block as Record<string, unknown>) };
		for (const key of ["text", "thinking", "output"]) {
			if (typeof copy[key] === "string") copy[key] = truncateText(copy[key], limit);
		}
		if (copy["arguments"] && typeof copy["arguments"] === "object") {
			copy["arguments"] = truncateArgs(copy["arguments"], limit);
		}
		if (copy["content"] !== undefined) copy["content"] = truncateContent(copy["content"], limit);
		return copy;
	});
}

function truncateEntry(entry: unknown, limit: number): unknown {
	if (!entry || typeof entry !== "object") return entry;
	const copy = { ...(entry as Record<string, unknown>) };
	if (typeof copy["summary"] === "string") copy["summary"] = truncateText(copy["summary"], limit);
	const message = copy["message"];
	if (message && typeof message === "object") {
		const next = { ...(message as Record<string, unknown>) };
		for (const key of ["output", "content"]) {
			if (next[key] !== undefined) next[key] = truncateContent(next[key], limit);
		}
		copy["message"] = next;
	}
	return copy;
}

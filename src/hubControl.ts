// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Hub methods split by concern; each function runs with the Hub instance as `this`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { RpcChild } from "./rpc.ts";
import { type PiBackend } from "./backend.ts";
import { MAX_UPLOAD_BYTES, normalizeImageAttachments, safeUploadName } from "./attachments.ts";
import { type NameSource } from "./sessionIndex.ts";
import {
	ENTRY_TEXT_LIMIT,
	WINDOW_BYTES,
	WINDOW_ENTRIES,
	parseEntries,
	readFromEnd,
	transcriptEntries,
	truncateEntries,
	SYMBOL_PENDING,
	coverageKeys,
} from "./jsonl.ts";
import { resolveSessionPolicy, type CommandLayer } from "./commands.ts";
import { isSlashPrompt } from "./titles.ts";
import { framePolicy } from "./wire.ts";
import type { BashResult, CommandPolicy, SessionInfo } from "./wire.ts";

const run = promisify(execFile);

/**
 * The supervisor. One `pi --mode rpc` child per live session, nothing else.
 *
 * Deliberate limitations for the prototype, all of which the Rust port keeps:
 * - no PTY, no tmux, no terminal mirroring;
 * - no re-encoding of Pi events (see wire.ts);
 * - session truth lives in Pi's own JSONL files, so the hub can be restarted and
 *   simply re-attach with `--session <file>`;
 * - bounded in-memory state: headers are cached by mtime, event forwarding is a
 *   direct string splice with no history kept server-side.
 */

export interface HubOptions {
	piBin: string;
	/** `pixip-pi-host` bin; when set, new and reattached sessions spawn it instead of `pi`. */
	piHostBin?: string;
	sessionsDir: string;
	/** `<data-dir>`: where `pixip.json`, the pid/log and the index live. */
	dataDir?: string;
	/** Plain JSON array mapping pixip logical ids to the Pi sessions they ran as. */
	indexPath: string;
	idleMs: number;
	extraPiArgs: string[];
	/** CLI command-policy layer (`--allow-command`/`--deny-command`/`--no-bash`). */
	cliCommands?: CommandLayer;
	/**
	 * Response timeout for `prompt`, in ms; `0` (default) waits forever because an
	 * extension command may block on a user dialog. Tests pass a small value.
	 */
	promptTimeoutMs?: number;
	/**
	 * How long a blocking extension UI request waits after the last client
	 * detaches before it is cancelled. A reconnect inside this window replays the
	 * request instead. `0` disables the safety cancel; default 2 minutes.
	 */
	pendingUiGraceMs?: number;
	/** Extra environment for every child; `process.env` is inherited first. */
	env?: Record<string, string | undefined>;
	/** Spawn seam for the RPC host; defaults to the real `pi --mode rpc` child. */
	backend?: PiBackend;
	/** How long deleted sessions stay restorable in the trash. Default 60 s. */
	trashGraceMs?: number;
	/** Model for automatic session labels (`provider/id`); defaults to the session's model. */
	titleModel?: string;
	/** One-shot title call timeout. Default 15 s. */
	titleTimeoutMs?: number;
	log: (message: string) => void;
}

/** Current extension UI, keyed by the addon's status/widget key. */
interface AddonUiCache {
	statuses: Map<string, string>;
	widgets: Map<string, { placement: "above" | "below"; frame: string }>;
}

interface PendingUiRequest {
	frame: string;
	method: string;
	request: Record<string, unknown>;
	raw: string;
	startedAt: number;
	timer?: NodeJS.Timeout;
}

interface LiveSession {
	proc: RpcChild;
	info: SessionInfo;
	subs: Set<Subscriber>;
	/** Latest setStatus/setWidget records, replayed to a late subscriber. */
	addonUi?: AddonUiCache;
	/** Unanswered select/confirm/input/editor/panel requests, replayed on reattach. */
	pendingUi?: Map<string, PendingUiRequest>;
	/** Consumed `hello` from `pixip-pi-host`; never forwarded as a transcript event. */
	host?: { protocol?: number; piVersion?: string; capabilities?: string[] };
	idleTimer?: NodeJS.Timeout;
	branch?: string;
	footerTimer?: NodeJS.Timeout;
	/** Effective command policy, resolved once at attach (or on soft refresh). */
	policy?: CommandPolicy;
	/** Id of the bash command currently running, if any (one at a time per session). */
	bashId?: string;
	/** Timestamp of the assistant message currently streaming (or last done). */
	assistantTs?: number;
	/** The automatic title has already been attempted for this session. */
	titleAttempted?: boolean;
	/** First prompt whose title call lost the provider race; retried at settle. */
	titlePending?: string;
	/** A first slash-command prompt: label from the expanded user message. */
	titleAwaitingMessage?: boolean;
	/** Raw slash-command prompt, used only when no expanded message arrives. */
	titlePrompt?: string;
	nameSource?: NameSource;
}

type Subscriber = (frame: string, key?: string) => void;

const SESSION_FILE = /\.jsonl$/;

/** A blocking dialog with no attached client is cancelled after this long. */
export const PENDING_UI_GRACE_MS = 120_000;

/** How far back one "load earlier" request may read before it gives up. */
const EARLIER_BYTES_CAP = 4 * 1024 * 1024;
/** Header scan: first line only, bounded so a 17 MB session costs one small read. */
const HEAD_BYTES = 8 * 1024;
/** Name scan: first ~20 lines, plus a bounded tail for sessions renamed later. */
const NAME_HEAD_LINES = 20;
const NAME_TAIL_BYTES = 16 * 1024;

export async function snapshot(
	this: any,
	id: string,
	limit = WINDOW_ENTRIES,
	since?: string,
): Promise<{ info: SessionInfo; entries: unknown[]; leafId: string | null; more: boolean; covered: string[] }> {
	const live = this.require(id);
	// `since` is Pi's durable cursor: only entries strictly after that entry.
	const data = (await live.proc.command({ type: "get_entries", ...(since ? { since } : {}) })) as {
		entries: unknown[];
		leafId: string | null;
	};
	const entries = data.entries ?? [];
	const windowed = entries.slice(-limit);
	return {
		info: live.info,
		entries: windowed,
		leafId: data.leafId ?? null,
		more: entries.length > windowed.length,
		// Coverage is computed over the full response, not the window: a buffered
		// record for an entry older than the window is still a duplicate.
		covered: coverageKeys(entries),
	};
}

export async function provisional(
	this: any,
	id: string,
	limit = WINDOW_ENTRIES,
	maxBytes = WINDOW_BYTES,
): Promise<{ info: SessionInfo; entries: unknown[]; leafId: string | null; more: boolean } | null> {
	if (this.live.has(id)) return null;
	const found = (await this.scan()).find((entry) => entry.header.id === id);
	if (!found) {
		// Index-only session: nothing to read yet, so paint the uniform empty
		// starting window instead of failing the connect.
		const record = await this.findRecord(id);
		if (!record) throw new Error(`unknown session ${id}`);
		const info: SessionInfo = {
			id: record.piId,
			logicalId: record.logicalId,
			cwd: record.cwd,
			name: record.name,
			state: "starting",
			sessionFile: record.sessionFile,
			lastActivity: Date.parse(record.createdAt) || 0,
		};
		return { info, entries: [], leafId: null, more: false };
	}

	let entries: unknown[] = [];
	let more = false;
	try {
		const tail = await readFromEnd(found.path, maxBytes);
		const parsed = transcriptEntries(parseEntries(tail.text, { dropFirst: tail.offset > 0 }));
		const windowed = parsed.slice(-limit);
		entries = truncateEntries(windowed, ENTRY_TEXT_LIMIT);
		more = tail.offset > 0 || parsed.length > windowed.length;
	} catch {
		// Missing or unreadable file: the uniform empty-starting snapshot covers it.
	}

	const info: SessionInfo = {
		id: found.header.id,
		logicalId: (await this.findRecord(found.header.id))?.logicalId,
		cwd: found.header.cwd,
		name: found.header.name,
		state: "starting",
		sessionFile: found.path,
		lastActivity: Date.parse(found.header.timestamp) || 0,
	};
	const leaf = entries.at(-1) as { id?: unknown } | undefined;
	return { info, entries, leafId: typeof leaf?.id === "string" ? leaf.id : null, more };
}

export async function earlier(
	this: any,
	id: string,
	before: string,
	limit = WINDOW_ENTRIES,
): Promise<{ entries: unknown[]; more: boolean }> {
	const path = await this.sessionPath(id);
	if (!path || !before) return { entries: [], more: false };

	for (let budget = WINDOW_BYTES; ; budget *= 4) {
		let tail: { text: string; offset: number };
		try {
			tail = await readFromEnd(path, budget);
		} catch {
			return { entries: [], more: false };
		}
		const parsed = transcriptEntries(parseEntries(tail.text, { dropFirst: tail.offset > 0 }));
		const index = parsed.findIndex((entry) => (entry as { id?: unknown })?.id === before);
		// Grow the read (bounded) until the window really holds `limit` entries:
		// one huge tool result must not shrink "load earlier" to a few rows.
		if (index >= limit || (index >= 0 && tail.offset === 0)) {
			const start = Math.max(0, index - limit);
			return { entries: parsed.slice(start, index), more: start > 0 || tail.offset > 0 };
		}
		if (tail.offset === 0 || budget >= EARLIER_BYTES_CAP) {
			if (index >= 0) {
				const start = Math.max(0, index - limit);
				return { entries: parsed.slice(start, index), more: start > 0 || tail.offset > 0 };
			}
			this.options.log(`earlier: anchor ${before} not found in ${path} (${budget} bytes)`);
			return { entries: [], more: false };
		}
	}
}

export async function sessionPath(this: any, id: string): Promise<string | undefined> {
	const live = this.live.get(id);
	if (live?.info.sessionFile) return live.info.sessionFile;
	const found = (await this.scan()).find((entry) => entry.header.id === id);
	return found?.path;
}

export async function prompt(
	this: any,
	id: string,
	text: string,
	streamingBehavior?: "steer" | "followUp",
	images?: unknown,
): Promise<void> {
	const attachments = normalizeImageAttachments(images);
	const live = this.require(id);
	this.touch(live);
	// The title call runs beside the real prompt; never wait for it here.
	if (!live.titleAttempted && !live.info.name && (live.info.messageCount ?? 0) === 0 && text.trim()) {
		live.titleAttempted = true;
		if (isSlashPrompt(text)) {
			// A slash command expands into the user message Pi actually runs
			// (extension commands such as `/fit work` send one themselves). Label
			// that result, not the alias: "/fit work" says nothing about the task.
			live.titleAwaitingMessage = true;
			live.titlePrompt = text;
		} else {
			void this.autoLabel(live, text);
		}
	}
	try {
		await live.proc.command(
			{
				type: "prompt",
				message: text,
				...(attachments.length > 0 ? { images: attachments } : {}),
				...(streamingBehavior ? { streamingBehavior } : {}),
			},
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		);
	} catch (error) {
		// Advisory: a late/failed prompt response must not become an error toast
		// (extension handlers legitimately outlive any timeout), so log it and
		// let the event stream be the source of truth.
		this.options.log(`prompt ${id}: ${(error as Error).message}`);
	} finally {
		// No run started (e.g. an extension command answered locally): restore
		// the idle-detach timer that `touch` cleared.
		if (live.info.state === "idle") this.scheduleIdle(live);
	}
}

export async function steer(this: any, id: string, text: string, images?: unknown): Promise<void> {
	await this.prompt(id, text, "steer", images);
}

export async function uploadFile(
	this: any,
	id: string,
	name: string,
	bytes: Buffer,
): Promise<{ path: string; name: string; size: number }> {
	const live = this.require(id);
	if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("file is too large (max 100 MB)");
	const cleanName = safeUploadName(name);
	const dir = this.uploadsDir(live.info.logicalId ?? live.info.id);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${randomUUID()}-${cleanName}`);
	await writeFile(path, bytes);
	return { path, name: cleanName, size: bytes.byteLength };
}

export async function clearQueue(this: any, id: string): Promise<{ steering: string[]; followUp: string[] }> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "clear_queue" })) as {
		steering?: unknown;
		followUp?: unknown;
	} | null;
	const texts = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return { steering: texts(data?.steering), followUp: texts(data?.followUp) };
}

export async function bash(
	this: any,
	id: string,
	bashId: string,
	command: string,
	excludeFromContext: boolean,
): Promise<BashResult> {
	const live = this.require(id);
	if (!command.trim()) throw new Error("empty bash command");
	if (live.bashId) throw new Error("a bash command is already running");
	live.bashId = bashId;
	// A long build must not be detached by the idle timer mid-run.
	this.clearIdle(live);
	try {
		const data = (await live.proc.command(
			{ type: "bash", command, excludeFromContext },
			{ id: bashId, timeoutMs: 0 },
		)) as {
			output?: string;
			exitCode?: number;
			cancelled?: boolean;
			truncated?: boolean;
			fullOutputPath?: string;
		} | null;
		return {
			output: typeof data?.output === "string" ? data.output : "",
			exitCode: typeof data?.exitCode === "number" ? data.exitCode : null,
			cancelled: Boolean(data?.cancelled),
			truncated: Boolean(data?.truncated),
			...(typeof data?.fullOutputPath === "string" ? { fullOutputPath: data.fullOutputPath } : {}),
		};
	} finally {
		live.bashId = undefined;
		if (live.info.state === "idle") this.scheduleIdle(live);
	}
}

export function policy(this: any, id: string): CommandPolicy {
	return this.require(id).policy ?? { allow: [], deny: [], bash: true };
}

export async function reload(this: any): Promise<{ sessions: number; policy: number }> {
	const dataDir = this.options.dataDir ?? dirname(this.options.sessionsDir);
	const updates: Array<{ live: LiveSession; policy: CommandPolicy }> = [];
	for (const [id, live] of this.live) {
		if (id === SYMBOL_PENDING) continue;
		const policy = await resolveSessionPolicy({
			dataDir,
			cwd: live.info.cwd,
			cli: this.options.cliCommands,
			log: this.options.log,
		});
		updates.push({ live, policy });
	}

	// The index file and the header cache are both re-read; JSONL mtimes keep
	// the second read cheap.
	this.index = undefined;
	this.files.clear();
	const sessions = await this.list();

	for (const update of updates) {
		update.live.policy = update.policy;
		this.broadcast(update.live, framePolicy(update.policy));
	}
	this.broadcastList(sessions);
	return { sessions: sessions.length, policy: updates.length };
}

export async function abort(this: any, id: string): Promise<void> {
	const live = this.require(id);
	await live.proc.command({ type: "abort" });
}

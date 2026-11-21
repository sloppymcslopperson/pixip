import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { RpcChild } from "./rpc.ts";
import { resolveSessionPolicy, type CommandLayer } from "./commands.ts";
import { resolveModelArgument, resolveThinkingArgument } from "./client/commands.js";
import { exportFileName } from "./client/sessionInfo.js";
import { fallbackTitle, normalizeTitle, titlePrompt } from "./titles.ts";
import { frameError, frameEvent, frameFooter, frameModels, framePolicy, frameSessions, frameSnapshot, frameStatus } from "./wire.ts";
import type { BashResult, CommandPolicy, DynamicCommand, FooterData, ModelSummary, SessionInfo, SessionState } from "./wire.ts";

const run = promisify(execFile);
const DEFAULT_TITLE_MODEL = "deepseek-v4.1-flash";

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

interface HubOptions {
	piBin: string;
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
	/** Extra environment for every child; `process.env` is inherited first. */
	env?: Record<string, string | undefined>;
	/** How long deleted sessions stay restorable in the trash. Default 60 s. */
	trashGraceMs?: number;
	/** Model for automatic session labels (`provider/id`); falls back to a cheap default. */
	titleModel?: string;
	/** One-shot title call timeout. Default 15 s. */
	titleTimeoutMs?: number;
	log: (message: string) => void;
}

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

interface SessionHeader {
	id: string;
	cwd: string;
	timestamp: string;
	/** Display name from the first `session_info` entry, when one is early in the file. */
	name?: string;
}

interface LiveSession {
	proc: RpcChild;
	info: SessionInfo;
	subs: Set<Subscriber>;
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
	nameSource?: NameSource;
}

/** A resolved logical session plus the JSONL files that belong to it. */
interface SessionTarget {
	info: SessionInfo;
	record: SessionIndexRecord;
	files: string[];
}

/**
 * A subscriber gets the verbatim frame plus an optional coverage key describing
 * the entry the record belongs to. Pi's RPC events carry no entry id, so the key
 * is the only way a socket can tell "already in the snapshot" from "newer".
 */
type Subscriber = (frame: string, key?: string) => void;

const SESSION_FILE = /\.jsonl$/;

/** Provisional / live transcript window: entries and raw line bytes. */
export const WINDOW_ENTRIES = 200;
export const WINDOW_BYTES = 256 * 1024;
/** Per-entry text cap in the provisional frame only. */
export const ENTRY_TEXT_LIMIT = 8 * 1024;
/** How far back one "load earlier" request may read before it gives up. */
const EARLIER_BYTES_CAP = 4 * 1024 * 1024;
/** Header scan: first line only, bounded so a 17 MB session costs one small read. */
const HEAD_BYTES = 8 * 1024;
/** Name scan: first ~20 lines, plus a bounded tail for sessions renamed later. */
const NAME_HEAD_LINES = 20;
const NAME_TAIL_BYTES = 16 * 1024;

export class Hub {
	private readonly options: HubOptions;
	private readonly live = new Map<string, LiveSession>();
	private readonly files = new Map<string, { mtimeMs: number; header: SessionHeader }>();
	private readonly watchers = new Set<Subscriber>();
	private index?: SessionIndexRecord[];
	/** Sockets that must follow a session to a new Pi id (`new_session`). */
	private readonly rekeyListeners = new Set<(from: string, info: SessionInfo) => void>();
	/** Serializes index writes; every mutation is read-modify-write inside it. */
	private indexWrite: Promise<void> = Promise.resolve();
	/** Last HTML export per Pi session id, so a download need not export twice. */
	private readonly exported = new Map<string, string>();
	private readonly archiveRoot: string;
	private readonly trashRoot: string;
	private readonly trashGraceMs: number;
	/** Startup cleanup runs once; trash operations wait for it. */
	private readonly startupTrash: Promise<void>;

	constructor(options: HubOptions) {
		this.options = options;
		const dataDir = options.dataDir ?? dirname(options.sessionsDir);
		this.archiveRoot = join(dataDir, "archive");
		this.trashRoot = join(dataDir, "trash");
		this.trashGraceMs = options.trashGraceMs ?? 60_000;
		this.startupTrash = this.purgeTrashOnStart();
	}

	// ---------------------------------------------------------------- listing

	async list(): Promise<SessionInfo[]> {
		const records = await this.readIndex();
		const recordFor = (piId: string) =>
			records.find((record) => record.piId === piId || record.piIds.includes(piId));
		const seen = new Set<string>();
		const infos: SessionInfo[] = [];
		// Live sessions first: a just-created session has no JSONL until its first
		// message, and it must still appear in the list.
		for (const [id, live] of this.live) {
			if (id === SYMBOL_PENDING) continue;
			seen.add(id);
			infos.push(live.info);
		}
		for (const { header, path } of await this.scan()) {
			if (seen.has(header.id)) continue;
			seen.add(header.id);
			// JSONL wins for state, name and activity; the index only adds the
			// logical id that ties a reattached Pi session to the same session.
			infos.push({
				id: header.id,
				logicalId: recordFor(header.id)?.logicalId,
				cwd: header.cwd,
				name: header.name,
				state: "stopped",
				sessionFile: path,
				lastActivity: Date.parse(header.timestamp) || 0,
			});
		}
		for (const record of records) {
			// Any Pi id of this logical session already listed (live or JSONL) wins.
			if (seen.has(record.piId) || record.piIds.some((id) => seen.has(id))) continue;
			infos.push({
				id: record.piId,
				logicalId: record.logicalId,
				cwd: record.cwd,
				name: record.name,
				state: "stopped",
				sessionFile: record.sessionFile,
				lastActivity: Date.parse(record.createdAt) || 0,
			});
		}
		infos.sort((a, b) => b.lastActivity - a.lastActivity);
		return infos;
	}

	watch(subscriber: Subscriber): () => void {
		this.watchers.add(subscriber);
		return () => this.watchers.delete(subscriber);
	}

	// ------------------------------------------------------------- lifecycle

	async create(cwd: string, name?: string): Promise<SessionInfo> {
		return await this.spawn({
			cwd,
			logicalId: randomUUID(),
			args: ["--mode", "rpc", "--session-dir", this.options.sessionsDir, ...(name ? ["--name", name] : [])],
		});
	}

	async attach(id: string): Promise<SessionInfo> {
		const existing = this.live.get(id);
		if (existing) return existing.info;
		const found = (await this.scan()).find((entry) => entry.header.id === id);
		if (found) {
			const record = await this.findRecord(id);
			return await this.spawn({
				cwd: found.header.cwd,
				logicalId: record?.logicalId,
				createdAt: record?.createdAt,
				args: ["--mode", "rpc", "--session", found.path],
			});
		}

		// No JSONL: an index-only session. Pi always allocates a fresh id at the
		// recorded path, so the caller follows the new id (`opened` on the socket).
		const record = await this.findRecord(id);
		if (!record) throw new Error(`unknown session ${id}`);
		const name = record.name ? ["--name", record.name] : [];
		const args = record.sessionFile
			? ["--mode", "rpc", "--session-dir", this.options.sessionsDir, "--session", record.sessionFile, ...name]
			: ["--mode", "rpc", "--session-dir", this.options.sessionsDir, ...name];
		return await this.spawn({ cwd: record.cwd, logicalId: record.logicalId, createdAt: record.createdAt, args });
	}

	async stop(id: string): Promise<SessionInfo> {
		const live = this.live.get(id);
		if (!live) {
			const known = (await this.list()).find((info) => info.id === id);
			if (!known) throw new Error(`unknown session ${id}`);
			return known;
		}
		this.clearIdle(live);
		this.live.delete(id);
		live.info.state = "stopped";
		await live.proc.close();
		this.emitStatus(live);
		this.broadcast(live, frameStatus(live.info));
		return live.info;
	}

	/**
	 * Archive one session: detach an idle child, move every JSONL of the logical
	 * session under `<data-dir>/archive`, drop the index record. Recoverable from
	 * the settings archive sheet; busy/starting sessions are refused.
	 */
	async archive(id: string): Promise<SessionInfo> {
		const { info } = await this.storeSession(id, this.archiveRoot);
		await this.broadcastSessions();
		return info;
	}

	/**
	 * Delete one session into `<data-dir>/trash`, with a short undo window before
	 * the files are purged. The same safety rules as archive apply.
	 */
	async deleteSession(id: string): Promise<{ info: SessionInfo; token: string; expiresAt: number }> {
		await this.startupTrash;
		const { info, record, dir } = await this.storeSession(id, this.trashRoot);
		const expiresAt = Date.now() + this.trashGraceMs;
		setTimeout(() => {
			void rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
				this.options.log(`trash purge failed for ${dir}: ${(error as Error).message}`);
			});
		}, this.trashGraceMs).unref();
		await this.broadcastSessions();
		return { info, token: record.logicalId, expiresAt };
	}

	/** Archive every stopped session, skipping failures so one bad file cannot block the batch. */
	async archiveInactive(): Promise<{ archived: SessionInfo[]; failed: Array<{ id: string; error: string }> }> {
		const sessions = await this.list();
		const archived: SessionInfo[] = [];
		const failed: Array<{ id: string; error: string }> = [];
		for (const session of sessions) {
			if (session.state !== "stopped") continue;
			try {
				archived.push((await this.storeSession(session.id, this.archiveRoot)).info);
			} catch (error) {
				failed.push({ id: session.id, error: (error as Error).message });
			}
		}
		await this.broadcastSessions();
		return { archived, failed };
	}

	async listArchived(): Promise<StoredSessionInfo[]> {
		return await this.listStored(this.archiveRoot, "archive");
	}

	async listTrash(): Promise<StoredSessionInfo[]> {
		await this.startupTrash;
		return await this.listStored(this.trashRoot, "trash");
	}

	async restoreArchived(id: string): Promise<SessionInfo> {
		return await this.restoreStored(this.archiveRoot, id);
	}

	async restoreTrash(id: string): Promise<SessionInfo> {
		await this.startupTrash;
		return await this.restoreStored(this.trashRoot, id);
	}

	async purgeArchived(id: string): Promise<void> {
		const found = await this.findStored(this.archiveRoot, id);
		if (!found) throw new Error(`unknown archived session ${id}`);
		await rm(found.dir, { recursive: true, force: true });
	}

	async purgeTrash(id: string): Promise<void> {
		await this.startupTrash;
		const found = await this.findStored(this.trashRoot, id);
		if (!found) throw new Error(`unknown deleted session ${id}`);
		await rm(found.dir, { recursive: true, force: true });
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.live.keys()].map((id) => this.stop(id).catch(() => {})));
	}

	// ---------------------------------------------------------------- control

	async snapshot(
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

	/**
	 * Provisional transcript straight off the JSONL tail, before the child has
	 * booted. Returns `null` for an already-live session (nothing to wait for).
	 * Never throws on a broken file: an unreadable tail yields empty entries.
	 */
	async provisional(
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

	/**
	 * One window of entries immediately before `before`, read from the JSONL while
	 * the live session keeps running. `more` says whether older entries remain.
	 */
	async earlier(
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

	private async sessionPath(id: string): Promise<string | undefined> {
		const live = this.live.get(id);
		if (live?.info.sessionFile) return live.info.sessionFile;
		const found = (await this.scan()).find((entry) => entry.header.id === id);
		return found?.path;
	}

	/**
	 * `streamingBehavior` is additive, not a mode switch: when Pi is idle it still
	 * starts a normal turn, when busy it steers/follows the run. Always using
	 * `prompt` (never RPC `steer`) also keeps extension commands executeable and
	 * means a message sent in the settle race starts a turn instead of sitting in
	 * Pi's steering queue until some later prompt happens to drain it.
	 */
	async prompt(id: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const live = this.require(id);
		this.touch(live);
		// The title call runs beside the real prompt; never wait for it here.
		if (!live.titleAttempted && !live.info.name && (live.info.messageCount ?? 0) === 0 && text.trim()) {
			live.titleAttempted = true;
			void this.autoLabel(live, text);
		}
		try {
			await live.proc.command(
				{ type: "prompt", message: text, ...(streamingBehavior ? { streamingBehavior } : {}) },
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

	/**
	 * Plain-text steer. It is `prompt` + `streamingBehavior: "steer"`, not RPC
	 * `steer`: that command only queues, so a steer that arrives while Pi is idle
	 * would never run, and the hub would stay "busy" forever because no
	 * `agent_start`/`agent_settled` ever follows.
	 */
	async steer(id: string, text: string): Promise<void> {
		await this.prompt(id, text, "steer");
	}

	/**
	 * `clear_queue`: drop every queued steering/follow-up message and return the
	 * texts. One call clears both lists (RPC semantics); the client restores them
	 * into the composer and never sends them automatically.
	 */
	async clearQueue(id: string): Promise<{ steering: string[]; followUp: string[] }> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "clear_queue" })) as {
			steering?: unknown;
			followUp?: unknown;
		} | null;
		const texts = (value: unknown): string[] =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		return { steering: texts(data?.steering), followUp: texts(data?.followUp) };
	}

	/**
	 * Run one `!`/`!!` command through Pi's RPC `bash`. The caller-supplied id is
	 * repeated on every `bash_execution_update`, so the client can stream into the
	 * card it already painted without the hub parsing events.
	 *
	 * One bash at a time per session (the TUI guard); output is left to the event
	 * stream and the final result, never buffered here.
	 */
	async bash(id: string, bashId: string, command: string, excludeFromContext: boolean): Promise<BashResult> {
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

	/** Effective per-session command policy (resolved at attach). */
	policy(id: string): CommandPolicy {
		return this.require(id).policy ?? { allow: [], deny: [], bash: true };
	}

	/**
	 * Soft refresh (`pixip refresh`, SIGHUP, `POST /api/refresh`): re-read the
	 * session index, re-resolve the command policy for every live session and
	 * re-send it, then refresh the list sockets. Children, sockets and in-flight
	 * turns are untouched.
	 *
	 * Two-phase on purpose: if any session's config is malformed, the refresh fails
	 * before a single policy is swapped, so a bad edit cannot half-apply.
	 */
	async reload(): Promise<{ sessions: number; policy: number }> {
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

	async abort(id: string): Promise<void> {
		const live = this.require(id);
		await live.proc.command({ type: "abort" });
	}

	async models(id: string): Promise<{ models: ModelSummary[]; current: string | null }> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_available_models" })) as { models?: ModelSummary[] };
		const models = (data.models ?? []).map((model) => ({
			id: String(model.id),
			provider: String(model.provider),
			contextWindow: model.contextWindow,
			reasoning: model.reasoning,
		}));
		return { models, current: live.info.model ?? null };
	}

	async setModel(id: string, provider: string, modelId: string): Promise<void> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "set_model", provider, modelId })) as { id?: string; provider?: string };
		live.info.model = data.id ?? modelId;
		this.emitStatus(live);
		await this.sendFooter(live);
	}

	/** `get_commands`: extension commands, prompt templates and skills for this child. */
	async commands(id: string): Promise<DynamicCommand[]> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_commands" })) as {
			commands?: Array<{ name?: unknown; description?: unknown; source?: unknown }>;
		};
		const commands: DynamicCommand[] = [];
		for (const raw of data.commands ?? []) {
			if (typeof raw?.name !== "string" || !raw.name.trim()) continue;
			const source = raw.source === "prompt" || raw.source === "skill" ? raw.source : "extension";
			commands.push({
				name: raw.name,
				source,
				...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
			});
		}
		return commands;
	}

	async thinkingLevels(id: string): Promise<{ levels: string[]; current: string }> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_available_thinking_levels" })) as { levels?: string[] };
		return { levels: data.levels ?? ["off"], current: live.info.thinkingLevel ?? "off" };
	}

	async setThinking(id: string, level: string): Promise<void> {
		const live = this.require(id);
		await live.proc.command({ type: "set_thinking_level", level });
		live.info.thinkingLevel = level;
		this.emitStatus(live);
		await this.sendFooter(live);
	}

	/** `/thinking <level>`: resolve against the levels Pi reports, then set. */
	async setThinkingQuery(id: string, query: string): Promise<void> {
		const { levels } = await this.thinkingLevels(id);
		const resolved = resolveThinkingArgument(levels, query) as {
			level?: string;
			error?: string;
		};
		if (!resolved.level) throw new Error(resolved.error ?? `unknown thinking level "${query}"`);
		await this.setThinking(id, resolved.level);
	}

	/** `/model <query>`: exact provider/id, exact id, then a unique suffix. */
	async setModelQuery(id: string, query: string): Promise<void> {
		const { models } = await this.models(id);
		const resolved = resolveModelArgument(models, query) as {
			model?: { id: string; provider: string };
			error?: string;
		};
		if (!resolved.model) throw new Error(resolved.error ?? `unknown model "${query}"`);
		await this.setModel(id, resolved.model.provider, resolved.model.id);
	}

	/** `/name <name>`: Pi appends the rename and emits `session_info_changed`. */
	async setName(id: string, name: string, source: NameSource = "manual"): Promise<void> {
		const live = this.require(id);
		const previous = { name: live.info.name, source: live.nameSource };
		// Set before the command so the matching `session_info_changed` event does
		// not mistake our own auto label for an external (manual) rename.
		live.info.name = name;
		live.nameSource = source;
		try {
			await live.proc.command({ type: "set_session_name", name });
		} catch (error) {
			live.info.name = previous.name;
			live.nameSource = previous.source;
			this.emitStatus(live);
			throw error;
		}
		this.emitStatus(live);
		if (live.info.logicalId) {
			await this.upsertIndex(live.info, live.info.logicalId, undefined, source).catch((error: unknown) => {
				this.options.log(`session index write failed: ${(error as Error).message}`);
			});
		}
	}

	/**
	 * First-prompt label: ask a one-shot child with no session/tools/extensions,
	 * then set the name only if the session is still unnamed. The real prompt has
	 * already been dispatched; nothing here is on its critical path.
	 */
	private async autoLabel(live: LiveSession, prompt: string): Promise<void> {
		let title = "";
		try {
			const model = await this.resolveTitleModel(live);
			title = normalizeTitle(await this.runTitlePi(live, prompt, model));
		} catch (error) {
			this.options.log(`auto title failed for ${live.info.id}: ${(error as Error).message}`);
		}
		if (!title) title = fallbackTitle(prompt);
		if (!title || this.live.get(live.info.id) !== live || live.info.name) return;
		try {
			await this.setName(live.info.id, title, "auto");
		} catch (error) {
			this.options.log(`auto title apply failed for ${live.info.id}: ${(error as Error).message}`);
		}
	}

	/** Configured model, then the cheap default, then the session's own model. */
	private async resolveTitleModel(live: LiveSession): Promise<string | undefined> {
		const requested = this.options.titleModel?.trim();
		let models: ModelSummary[] = [];
		try {
			models = (await this.models(live.info.id)).models;
		} catch {
			// A session with no model discovery still gets the configured/default id.
		}
		const resolve = (query: string): ModelSummary | undefined => {
			const result = resolveModelArgument(models, query) as { model?: ModelSummary };
			return result.model;
		};
		const sessionModel = models.find((model) => model.id === live.info.model) ?? (models.length === 1 ? models[0] : undefined);
		const chosen = requested
			? resolve(requested) ?? sessionModel
			: resolve(DEFAULT_TITLE_MODEL) ?? sessionModel;
		if (!chosen) return requested || undefined;
		return chosen.provider ? `${chosen.provider}/${chosen.id}` : chosen.id;
	}

	private async runTitlePi(live: LiveSession, prompt: string, model?: string): Promise<string> {
		const args = [
			"--print",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-mcp",
			"--thinking",
			"off",
		];
		if (model) args.push("--model", model);
		args.push(titlePrompt(prompt));
		const { stdout } = await run(this.options.piBin, args, {
			cwd: live.info.cwd,
			env: { ...process.env, ...this.options.env },
			timeout: this.options.titleTimeoutMs ?? 15_000,
			maxBuffer: 256 * 1024,
		});
		return stdout;
	}

	/** `/compact [instructions]`: manual compaction; the client resnapshots after. */
	async compact(id: string, instructions?: string): Promise<void> {
		const live = this.require(id);
		await live.proc.command(
			{ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) },
			{ timeoutMs: 0 },
		);
		// The context window and token totals changed; the footer must follow.
		await this.sendFooter(live);
	}

	/** `/copy`: Pi's own last assistant text, not a client-side reconstruction. */
	async lastAssistantText(id: string): Promise<string | null> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_last_assistant_text" })) as { text?: string | null } | null;
		return typeof data?.text === "string" ? data.text : null;
	}

	/** Read-only session tree for `/tree` (RPC `get_tree`). */
	async tree(id: string): Promise<{ tree: unknown[]; leafId: string | null }> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_tree" })) as { tree?: unknown; leafId?: unknown } | null;
		return {
			tree: Array.isArray(data?.tree) ? data.tree : [],
			leafId: typeof data?.leafId === "string" ? data.leafId : null,
		};
	}

	/**
	 * `/fork <entryId>`: fork from a user message. Pi allocates the new session id,
	 * so the live entry is re-keyed exactly like `/new`; a cancelled fork is not an
	 * error.
	 */
	async fork(id: string, entryId: string): Promise<{ text: string | null; cancelled: boolean }> {
		const live = this.require(id);
		if (!entryId) throw new Error("fork needs a user-message entry id");
		const data = (await live.proc.command(
			{ type: "fork", entryId },
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		) as { text?: unknown; cancelled?: unknown } | null);
		if (data?.cancelled) return { text: null, cancelled: true };
		await this.rekeyFromState(live);
		return { text: typeof data?.text === "string" ? data.text : null, cancelled: false };
	}

	/** `/clone`: duplicate the active branch; same re-key path as `/fork`. */
	async clone(id: string): Promise<{ cancelled: boolean }> {
		const live = this.require(id);
		const data = (await live.proc.command(
			{ type: "clone" },
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		) as { cancelled?: unknown } | null);
		if (data?.cancelled) return { cancelled: true };
		await this.rekeyFromState(live);
		return { cancelled: false };
	}

	/**
	 * `/import <path>`: copy a JSONL into `<data-dir>/sessions/` (header id and cwd
	 * untouched, source never modified), index it as its own logical session and
	 * switch the live child to it.
	 */
	async importSession(id: string, sourcePath: string): Promise<{ info: SessionInfo; cancelled: boolean }> {
		const live = this.require(id);
		if (!sourcePath.trim()) throw new Error("import needs a session file path");
		const source = resolve(live.info.cwd, sourcePath);
		const text = await readFile(source, "utf8");
		const first = text.split("\n").find((line) => line.trim());
		let header: { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown };
		try {
			header = JSON.parse(first ?? "{}") as typeof header;
		} catch {
			throw new Error(`${sourcePath}: not a JSONL session file`);
		}
		if (header.type !== "session" || typeof header.id !== "string") {
			throw new Error(`${sourcePath}: not a Pi session file`);
		}
		// The id becomes part of the copied filename: reject path separators and
		// traversal so a foreign file cannot write outside the sessions dir.
		if (!/^[A-Za-z0-9._-]+$/.test(header.id) || header.id.includes("..")) {
			throw new Error(`${sourcePath}: invalid session id`);
		}
		if (this.live.has(header.id)) throw new Error(`session ${header.id} is already attached`);

		await mkdir(this.options.sessionsDir, { recursive: true });
		const stamp = (typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString()).replace(/[:.]/g, "-");
		const target = join(this.options.sessionsDir, `${stamp}_${header.id}.jsonl`);
		if (resolve(target) !== source) await writeFile(target, text);

		const existing = await this.findRecord(header.id);
		const logicalId = existing?.logicalId ?? randomUUID();
		const imported: SessionInfo = {
			id: header.id,
			logicalId,
			cwd: typeof header.cwd === "string" ? header.cwd : live.info.cwd,
			name: nameFromLines(text.split("\n").slice(0, NAME_HEAD_LINES)),
			state: "idle",
			sessionFile: target,
			lastActivity: Date.now(),
		};
		await this.upsertIndex(imported, logicalId, undefined, imported.name ? "manual" : undefined);

		// The live session now *is* the imported one: follow its identity and cwd.
		live.info.logicalId = logicalId;
		live.info.cwd = imported.cwd;
		const result = (await live.proc.command(
			{ type: "switch_session", sessionPath: target },
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		) as { cancelled?: boolean } | null) ?? {};
		if (result.cancelled) return { info: live.info, cancelled: true };

		const info = await this.rekeyFromState(live);
		if (!info.name && imported.name) {
			info.name = imported.name;
			live.nameSource = "manual";
			this.emitStatus(live);
			if (info.logicalId) await this.upsertIndex(info, info.logicalId, undefined, "manual");
		}
		return { info, cancelled: false };
	}

	private exportsDir(): string {
		return join(this.options.dataDir ?? dirname(this.options.sessionsDir), "exports");
	}

	/** `/export`: HTML under `<data-dir>/exports`, served by the HTTP route. */
	async exportHtml(id: string): Promise<string> {
		const live = this.require(id);
		const dir = this.exportsDir();
		await mkdir(dir, { recursive: true });
		const requested = join(dir, exportFileName(live.info, "html"));
		const data = (await live.proc.command({ type: "export_html", outputPath: requested })) as { path?: unknown } | null;
		const written = typeof data?.path === "string" ? data.path : requested;
		this.exported.set(live.info.id, written);
		return written;
	}

	/** Last exported HTML for this session, exporting on demand (fresh daemon). */
	async exportedHtml(id: string): Promise<string> {
		return this.exported.get(id) ?? (await this.exportHtml(id));
	}

	/** Whatever file Pi currently has this session open on (for JSONL export). */
	async sessionFile(id: string): Promise<string | undefined> {
		return await this.sessionPath(id);
	}

	/**
	 * `/new`: a fresh session in the same child (TUI behaviour). Pi allocates the
	 * new id, so the live entry, the socket's active id and the index `piIds` are
	 * re-keyed; subscribers keep their socket and are told to follow.
	 */
	async newSession(id: string): Promise<SessionInfo> {
		const live = this.require(id);
		const result = (await live.proc.command(
			{ type: "new_session" },
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		) as { cancelled?: boolean } | null) ?? {};
		if (result.cancelled) throw new Error("new session was cancelled by an extension");
		return await this.rekeyFromState(live);
	}

	/**
	 * Follow the same live entry to whatever Pi id `get_state` reports now. The
	 * one re-key path for `/new`, `/fork`, `/clone` and `/import`: mutate the
	 * info in place (the child's `onRecord` closure holds the reference), move the
	 * map entry, append the id to the index and tell every socket to follow.
	 */
	private async rekeyFromState(live: LiveSession): Promise<SessionInfo> {
		const state = (await live.proc.command({ type: "get_state" })) as {
			sessionId?: string;
			sessionFile?: string;
			sessionName?: string;
			model?: { id?: string };
			thinkingLevel?: string;
			messageCount?: number;
			isStreaming?: boolean;
		};
		if (!state.sessionId) throw new Error("pi did not report a session id");

		const info = live.info;
		const previous = info.id;
		const previousName = info.name;
		info.id = state.sessionId;
		info.sessionFile = state.sessionFile ?? info.sessionFile;
		info.name = state.sessionName;
		info.model = state.model?.id ?? info.model;
		info.thinkingLevel = state.thinkingLevel ?? info.thinkingLevel;
		info.messageCount = state.messageCount ?? 0;
		info.state = state.isStreaming ? "busy" : "idle";
		info.lastActivity = Date.now();
		if (info.name !== previousName) live.nameSource = info.name ? "manual" : undefined;
		if (previous !== info.id) live.titleAttempted = false;
		this.live.delete(previous);
		this.live.set(info.id, live);

		if (info.logicalId) {
			await this.upsertIndex(info, info.logicalId, undefined, live.nameSource).catch((error: unknown) => {
				this.options.log(`session index write failed: ${(error as Error).message}`);
			});
		}
		for (const listener of this.rekeyListeners) {
			try {
				listener(previous, info);
			} catch {
				this.rekeyListeners.delete(listener);
			}
		}
		this.emitStatus(live);
		this.clearIdle(live);
		if (info.state === "idle") this.scheduleIdle(live);
		return info;
	}

	/** Follow a session to a new Pi id (registered by the socket layer). */
	onRekey(listener: (from: string, info: SessionInfo) => void): () => void {
		this.rekeyListeners.add(listener);
		return () => this.rekeyListeners.delete(listener);
	}

	/** Answer an extension dialog (`ctx.ui.confirm` and friends) from the phone. */
	uiResponse(id: string, requestId: string, fields: Record<string, unknown>): void {
		const live = this.require(id);
		live.proc.send({ type: "extension_ui_response", id: requestId, ...fields });
	}

	subscribe(id: string, subscriber: Subscriber): () => void {
		const live = this.live.get(id);
		if (!live) return () => {};
		live.subs.add(subscriber);
		return () => {
			live.subs.delete(subscriber);
		};
	}

	// ----------------------------------------------------------------- spawn

	private async spawn(input: {
		cwd: string;
		args: string[];
		logicalId?: string;
		createdAt?: string;
	}): Promise<SessionInfo> {
		const started = Date.now();
		const logicalId = input.logicalId ?? randomUUID();
		let resolveState!: (info: SessionInfo) => void;
		let rejectState!: (error: Error) => void;
		const ready = new Promise<SessionInfo>((resolve, reject) => {
			resolveState = resolve;
			rejectState = reject;
		});
		// The policy read below can fail before this promise is awaited; keep the
		// later `onExit` rejection from becoming an unhandled rejection.
		ready.catch(() => {});

		const info: SessionInfo = {
			id: "",
			logicalId,
			cwd: input.cwd,
			state: "starting",
			lastActivity: started,
		};

		const proc = new RpcChild({
			command: this.options.piBin,
			args: [...input.args, ...this.options.extraPiArgs],
			cwd: input.cwd,
			env: { ...this.options.env, PIXIP_SESSION_ID: logicalId, PIXIP_INSIDE: "1" },
			onRecord: (raw, record) => this.onRecord(info, raw, record),
			onStderr: (chunk) => this.options.log(`[pi ${input.cwd}] ${chunk.trimEnd()}`),
			onExit: (code, signal) => {
				const live = this.live.get(info.id);
				if (live?.proc === proc) {
					this.live.delete(info.id);
					this.clearIdle(live);
					live.info.state = "error";
					this.broadcast(live, frameError(`pi exited (${code ?? signal})`));
					this.emitStatus(live);
				}
				rejectState(new Error(`pi exited during startup (${code ?? signal})`));
			},
		});

		const live: LiveSession = { proc, info, subs: new Set() };
		// Register before the first command so records that arrive early find it.
		this.live.set(SYMBOL_PENDING, live);

		const state = (await proc.command({ type: "get_state" })) as {
			sessionId?: string;
			sessionFile?: string;
			sessionName?: string;
			model?: { id?: string };
			thinkingLevel?: string;
			messageCount?: number;
			isStreaming?: boolean;
		};

		if (!state.sessionId) throw new Error("pi did not report a session id");
		info.id = state.sessionId;
		info.sessionFile = state.sessionFile;
		info.name = state.sessionName;
		info.model = state.model?.id;
		info.thinkingLevel = state.thinkingLevel;
		info.messageCount = state.messageCount;
		info.state = state.isStreaming ? "busy" : "idle";
		info.lastActivity = Date.now();
		const existing = await this.findRecord(logicalId);
		live.nameSource = existing?.nameSource;
		if (info.name !== undefined) {
			live.nameSource = existing?.name === info.name ? existing.nameSource : "manual";
		}

		// Resolve the command policy before the session is usable: a malformed
		// config fails the attach with the file path instead of silently allowing
		// or blocking commands. Read once per attach; a soft refresh re-resolves.
		try {
			live.policy = await resolveSessionPolicy({
				dataDir: this.options.dataDir ?? dirname(this.options.sessionsDir),
				cwd: info.cwd,
				cli: this.options.cliCommands,
				log: this.options.log,
			});
		} catch (error) {
			this.live.delete(SYMBOL_PENDING);
			await proc.close();
			throw error;
		}

		this.live.delete(SYMBOL_PENDING);
		const previous = this.live.get(info.id);
		if (previous) await previous.proc.close();
		this.live.set(info.id, live);

		// Persist the logical -> Pi id mapping. A broken index must never take a
		// session down, so a failed write is only logged.
		await this.upsertIndex(info, logicalId, input.createdAt, live.nameSource).catch((error: unknown) => {
			this.options.log(`session index write failed: ${(error as Error).message}`);
		});

		this.options.log(`attached ${info.id} (${info.cwd}) in ${Date.now() - started}ms`);
		this.emitStatus(live);
		if (info.state === "idle") this.scheduleIdle(live);
		resolveState(info);
		return await ready;
	}

	// --------------------------------------------------------------- records

	private onRecord(info: SessionInfo, raw: string, record: unknown): void {
		const live = this.live.get(info.id);
		const target = live ?? this.pendingSession(info);
		if (!target) return;
		const typed = record as { type?: string; name?: string; message?: unknown; assistantMessageEvent?: { type?: string } };
		// Stamp the entry identity once, before the status bookkeeping below.
		const key = coverageKey(target, typed);

		switch (typed.type) {
			case "agent_start":
				target.info.state = "busy";
				this.clearIdle(target);
				this.emitStatus(target);
				break;
			case "agent_settled":
				target.info.state = "idle";
				target.info.lastActivity = Date.now();
				this.emitStatus(target);
				this.scheduleFooter(target);
				this.scheduleIdle(target);
				break;
			case "session_info_changed":
				if (target.info.name !== typed.name) target.nameSource = "manual";
				target.info.name = typed.name;
				this.emitStatus(target);
				void this.persistName(target);
				break;
			case "message_end": {
				const message = typed.message as { role?: string } | undefined;
				if (message?.role === "user") target.info.messageCount = (target.info.messageCount ?? 0) + 1;
				if (message?.role === "assistant") this.scheduleFooter(target);
				break;
			}
			case "thinking_level_changed": {
				const level = (typed as { level?: string }).level;
				if (level) target.info.thinkingLevel = level;
				this.emitStatus(target);
				this.scheduleFooter(target);
				break;
			}
			default:
				break;
		}

		this.broadcast(target, frameEvent(raw), key);
	}

	private pendingSession(info: SessionInfo): LiveSession | undefined {
		const candidate = this.live.get(SYMBOL_PENDING);
		return candidate && candidate.info === info ? candidate : undefined;
	}

	// ---------------------------------------------------------------- footer

	/**
	 * The TUI footer, as data: cwd (with branch and session name), usage totals,
	 * context usage, and the model/thinking pair. Formatting lives in the client so
	 * this stays a thin passthrough of `get_session_stats` + `get_state`.
	 */
	async footer(id: string): Promise<FooterData> {
		const live = this.require(id);
		const [stats, state] = await Promise.all([
			live.proc.command({ type: "get_session_stats" }) as Promise<{
				tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
				cost?: number;
				contextUsage?: { percent?: number | null; contextWindow?: number };
			}>,
			live.proc.command({ type: "get_state" }) as Promise<{
				model?: { id?: string; provider?: string; reasoning?: boolean; contextWindow?: number };
				thinkingLevel?: string;
				autoCompactionEnabled?: boolean;
			}>,
		]);
		if (!live.branch) live.branch = await this.gitBranch(live.info.cwd);
		return {
			cwd: live.info.cwd,
			home: process.env["HOME"] ?? "",
			branch: live.branch,
			name: live.info.name,
			tokens: {
				input: stats.tokens?.input ?? 0,
				output: stats.tokens?.output ?? 0,
				cacheRead: stats.tokens?.cacheRead ?? 0,
				cacheWrite: stats.tokens?.cacheWrite ?? 0,
			},
			cost: stats.cost ?? 0,
			context: {
				percent: stats.contextUsage?.percent ?? null,
				window: stats.contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0,
			},
			autoCompact: state.autoCompactionEnabled ?? true,
			model: state.model?.id
				? {
						id: state.model.id,
						provider: state.model.provider ?? "",
						reasoning: Boolean(state.model.reasoning),
					}
				: null,
			thinking: state.thinkingLevel ?? live.info.thinkingLevel ?? "off",
			providerCount: 0,
		};
	}

	async sendFooter(live: LiveSession): Promise<void> {
		try {
			this.broadcast(live, frameFooter(await this.footer(live.info.id)));
		} catch {
			// a session that is mid-shutdown has no footer to send
		}
	}

	private scheduleFooter(live: LiveSession): void {
		if (live.footerTimer) return;
		live.footerTimer = setTimeout(() => {
			live.footerTimer = undefined;
			void this.sendFooter(this.live.get(live.info.id) ?? live);
		}, 150);
	}

	private async gitBranch(cwd: string): Promise<string | undefined> {
		try {
			const { stdout } = await run("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2000 });
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------ session index

	private async readIndex(): Promise<SessionIndexRecord[]> {
		if (this.index) return this.index;
		let records: SessionIndexRecord[] = [];
		try {
			const parsed = JSON.parse(await readFile(this.options.indexPath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const raw of parsed) records.push(...normalizeRecord(raw, this.options.sessionsDir));
			}
		} catch (error) {
			// A missing index is the normal empty case; a corrupt one is logged and
			// ignored, because JSONL sessions must keep listing regardless.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.options.log(`session index unreadable (${(error as Error).message}); starting empty`);
			}
		}
		this.index = records;
		return records;
	}

	private async findRecord(id: string): Promise<SessionIndexRecord | undefined> {
		const records = await this.readIndex();
		return records.find((record) => record.logicalId === id || record.piId === id || record.piIds.includes(id));
	}

	private async upsertIndex(
		info: SessionInfo,
		logicalId: string,
		createdAt?: string,
		nameSource?: NameSource,
	): Promise<void> {
		if (!info.id) return;
		await this.mutateIndex((records) => {
			const existing = records.find((record) => record.logicalId === logicalId);
			const piIds = existing ? [...existing.piIds] : [];
			if (!piIds.includes(info.id)) piIds.push(info.id);
			const name = info.name ?? existing?.name;
			const source =
				nameSource ??
				(info.name !== undefined && existing?.name !== info.name ? "manual" : existing?.nameSource);
			const next: SessionIndexRecord = {
				logicalId,
				piId: info.id,
				piIds,
				cwd: info.cwd,
				name,
				nameSource: source,
				sessionFile: info.sessionFile ?? existing?.sessionFile,
				createdAt: existing?.createdAt ?? createdAt ?? new Date().toISOString(),
			};
			const index = records.findIndex((record) => record.logicalId === logicalId);
			return index >= 0 ? records.map((record, at) => (at === index ? next : record)) : [...records, next];
		});
	}

	/** Archive/trash one session; shared by single, bulk and delete paths. */
	private async storeSession(id: string, root: string): Promise<{ info: SessionInfo; record: SessionIndexRecord; dir: string }> {
		const live = this.findLive(id);
		if (live) {
			const state = live.info.state;
			if (state === "busy" || state === "starting") throw new Error(`session ${id} is ${state}; stop it first`);
			await this.stop(live.info.id);
		}
		const target = await this.resolveTarget(id);
		const dir = join(root, `${safeName(target.record.logicalId)}-${randomUUID().slice(0, 8)}`);
		const files = await this.moveSessionFiles(target.files, dir);
		const record: StoredSessionRecord = {
			...target.record,
			storedAt: new Date().toISOString(),
			files,
		};
		try {
			await writeFile(join(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
		} catch (error) {
			await this.rollbackFiles(files, dir);
			throw error;
		}
		await this.removeRecord(target.record);
		this.files.clear();
		for (const piId of target.record.piIds) this.exported.delete(piId);
		return {
			info: { ...target.info, state: "stopped", sessionFile: target.record.sessionFile },
			record: target.record,
			dir,
		};
	}

	private findLive(id: string): LiveSession | undefined {
		const direct = this.live.get(id);
		if (direct) return direct;
		for (const live of this.live.values()) {
			if (live.info.logicalId === id) return live;
		}
		return undefined;
	}

	/** Find the logical session by Pi id or logical id, and every JSONL it owns. */
	private async resolveTarget(id: string): Promise<SessionTarget> {
		const infos = await this.list();
		const info = infos.find((session) => session.id === id || session.logicalId === id);
		const records = await this.readIndex();
		let record = records.find((item) => item.logicalId === id || item.piId === id || item.piIds.includes(id));
		if (!record && info) {
			record = records.find(
				(item) =>
					item.logicalId === info.logicalId ||
					item.piId === info.id ||
					item.piIds.includes(info.id),
			);
		}
		if (!record) {
			if (!info) throw new Error(`unknown session ${id}`);
			record = {
				logicalId: info.logicalId ?? info.id,
				piId: info.id,
				piIds: [info.id],
				cwd: info.cwd,
				name: info.name,
				sessionFile: info.sessionFile,
				createdAt: new Date(info.lastActivity || Date.now()).toISOString(),
			};
		}
		const piIds = [...new Set([...record.piIds, record.piId, ...(info ? [info.id] : [])])];
		const scanned = await this.scan();
		const paths = new Set<string>();
		for (const entry of scanned) {
			if (piIds.includes(entry.header.id)) paths.add(entry.path);
		}
		if (record.sessionFile) paths.add(record.sessionFile);
		if (info?.sessionFile) paths.add(info.sessionFile);
		const files: string[] = [];
		for (const path of paths) {
			if (await pathExists(path)) files.push(path);
		}
		const resolved: SessionInfo = info ?? {
			id: record.piId,
			logicalId: record.logicalId,
			cwd: record.cwd,
			name: record.name,
			state: "stopped",
			sessionFile: record.sessionFile,
			lastActivity: Date.parse(record.createdAt) || 0,
		};
		return { info: resolved, record, files };
	}

	private async removeRecord(record: SessionIndexRecord): Promise<void> {
		const ids = new Set([...record.piIds, record.piId]);
		await this.mutateIndex((records) =>
			records.filter(
				(existing) =>
					existing.logicalId !== record.logicalId &&
					!ids.has(existing.piId) &&
					!existing.piIds.some((id) => ids.has(id)),
			),
		);
	}

	private async putRecord(record: SessionIndexRecord): Promise<void> {
		const ids = new Set([...record.piIds, record.piId]);
		await this.mutateIndex((records) => [
			...records.filter(
				(existing) =>
					existing.logicalId !== record.logicalId &&
					!ids.has(existing.piId) &&
					!existing.piIds.some((id) => ids.has(id)),
			),
			record,
		]);
	}

	private async moveSessionFiles(files: string[], dir: string): Promise<Array<{ original: string; stored: string }>> {
		await mkdir(dir, { recursive: true });
		const moved: Array<{ original: string; stored: string }> = [];
		try {
			for (const original of files) {
				const base = safeName(basename(original));
				let stored = base;
				for (let suffix = 1; await pathExists(join(dir, stored)); suffix += 1) {
					stored = base.endsWith(".jsonl") ? `${base.slice(0, -".jsonl".length)}-${suffix}.jsonl` : `${base}-${suffix}`;
				}
				await moveFile(original, join(dir, stored));
				moved.push({ original, stored });
			}
			return moved;
		} catch (error) {
			await this.rollbackFiles(moved, dir);
			throw error;
		}
	}

	private async rollbackFiles(moved: Array<{ original: string; stored: string }>, dir: string): Promise<void> {
		for (const item of [...moved].reverse()) {
			await moveFile(join(dir, item.stored), item.original).catch(() => {});
		}
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	private async restoreStored(root: string, id: string): Promise<SessionInfo> {
		const found = await this.findStored(root, id);
		if (!found) throw new Error(`unknown stored session ${id}`);
		const { record, dir } = found;
		const restored: SessionIndexRecord = {
			logicalId: record.logicalId,
			piId: record.piId,
			piIds: [...record.piIds],
			cwd: record.cwd,
			name: record.name,
			nameSource: record.nameSource,
			sessionFile: record.sessionFile,
			createdAt: record.createdAt,
		};
		const mapping = new Map<string, string>();
		const moved: Array<{ stored: string; target: string }> = [];
		try {
			for (const file of record.files) {
				const target = await uniquePath(file.original);
				await moveFile(join(dir, file.stored), target);
				mapping.set(file.original, target);
				moved.push({ stored: file.stored, target });
			}
		} catch (error) {
			for (const item of [...moved].reverse()) {
				await moveFile(item.target, join(dir, item.stored)).catch(() => {});
			}
			throw error;
		}
		if (record.sessionFile) restored.sessionFile = mapping.get(record.sessionFile) ?? record.sessionFile;
		if (!restored.sessionFile && record.files[0]) {
			restored.sessionFile = mapping.get(record.files[0].original) ?? record.files[0].original;
		}
		await this.putRecord(restored);
		await rm(dir, { recursive: true, force: true });
		this.files.clear();
		await this.broadcastSessions();
		return {
			id: restored.piId,
			logicalId: restored.logicalId,
			cwd: restored.cwd,
			name: restored.name,
			state: "stopped",
			sessionFile: restored.sessionFile,
			lastActivity: Date.now(),
		};
	}

	private async listStored(root: string, kind: "archive" | "trash"): Promise<StoredSessionInfo[]> {
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		const items: StoredSessionInfo[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const record = await this.readStoredRecord(join(root, entry.name));
			if (record) items.push(storedInfo(record, kind, this.trashGraceMs));
		}
		items.sort((a, b) => b.lastActivity - a.lastActivity);
		return items;
	}

	private async findStored(root: string, id: string): Promise<{ dir: string; record: StoredSessionRecord } | undefined> {
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(root, entry.name);
			const record = await this.readStoredRecord(dir);
			if (!record) continue;
			if (record.logicalId === id || record.piId === id || record.piIds.includes(id) || entry.name === id) {
				return { dir, record };
			}
		}
		return undefined;
	}

	private async readStoredRecord(dir: string): Promise<StoredSessionRecord | undefined> {
		try {
			const parsed = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Partial<StoredSessionRecord>;
			if (typeof parsed.logicalId !== "string" || typeof parsed.piId !== "string" || typeof parsed.storedAt !== "string") return undefined;
			const piIds = Array.isArray(parsed.piIds)
				? parsed.piIds.filter((id): id is string => typeof id === "string")
				: [];
			const files = Array.isArray(parsed.files)
				? parsed.files.filter(
						(file): file is { original: string; stored: string } =>
							typeof file?.original === "string" && typeof file?.stored === "string",
					)
				: [];
			return {
				logicalId: parsed.logicalId,
				piId: parsed.piId,
				piIds: piIds.includes(parsed.piId) ? piIds : [...piIds, parsed.piId],
				cwd: typeof parsed.cwd === "string" ? parsed.cwd : this.options.sessionsDir,
				name: typeof parsed.name === "string" ? parsed.name : undefined,
				nameSource: parsed.nameSource === "auto" || parsed.nameSource === "manual" ? parsed.nameSource : undefined,
				sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
				createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : parsed.storedAt,
				storedAt: parsed.storedAt,
				files,
			};
		} catch {
			return undefined;
		}
	}

	private async purgeTrashOnStart(): Promise<void> {
		const entries = await readdir(this.trashRoot, { withFileTypes: true }).catch(() => []);
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => rm(join(this.trashRoot, entry.name), { recursive: true, force: true }).catch(() => {})),
		);
	}

	private async broadcastSessions(): Promise<void> {
		this.broadcastList(await this.list());
	}

	/** Read-modify-write serialized behind `indexWrite`; atomic on disk. */
	private mutateIndex(mutate: (records: SessionIndexRecord[]) => SessionIndexRecord[]): Promise<void> {
		const run = async () => {
			const next = mutate(await this.readIndex());
			this.index = next;
			const path = this.options.indexPath;
			await mkdir(dirname(path), { recursive: true });
			const temp = `${path}.${process.pid}.tmp`;
			await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
			await rename(temp, path);
		};
		this.indexWrite = this.indexWrite.then(run, run);
		return this.indexWrite;
	}

	/**
	 * Names live in the JSONL once it exists, but `nameSource` is index-owned:
	 * write both so a restart knows an auto label from a manual rename.
	 */
	private async persistName(live: LiveSession): Promise<void> {
		const { info } = live;
		if (!info.logicalId) return;
		await this.upsertIndex(info, info.logicalId, undefined, live.nameSource).catch((error: unknown) => {
			this.options.log(`session index write failed: ${(error as Error).message}`);
		});
	}

	// --------------------------------------------------------------- plumbing

	private require(id: string): LiveSession {
		const live = this.live.get(id);
		if (!live) throw new Error(`session ${id} is not attached`);
		return live;
	}

	private broadcast(live: LiveSession, frame: string, key?: string): void {
		for (const subscriber of live.subs) {
			try {
				subscriber(frame, key);
			} catch {
				live.subs.delete(subscriber);
			}
		}
	}

	private emitStatus(live: LiveSession): void {
		const frame = frameStatus(live.info);
		this.broadcast(live, frame);
		if (this.watchers.size > 0) {
			for (const watcher of this.watchers) {
				try {
					watcher(frame);
				} catch {
					this.watchers.delete(watcher);
				}
			}
		}
	}

	/** Fresh `sessions` frame to the list sockets after a soft refresh. */
	private broadcastList(infos: SessionInfo[]): void {
		if (this.watchers.size === 0) return;
		const frame = frameSessions(infos);
		for (const watcher of this.watchers) {
			try {
				watcher(frame);
			} catch {
				this.watchers.delete(watcher);
			}
		}
	}

	/**
	 * Activity bookkeeping only. The run state belongs to Pi's lifecycle events:
	 * inventing "busy" here latched sessions busy for commands that never start a
	 * run (RPC `steer` while idle, extension commands handled locally), and no
	 * `agent_settled` ever arrived to clear it.
	 */
	private touch(live: LiveSession): void {
		live.info.lastActivity = Date.now();
		this.clearIdle(live);
	}

	private scheduleIdle(live: LiveSession): void {
		const { idleMs } = this.options;
		if (idleMs <= 0) return;
		this.clearIdle(live);
		live.idleTimer = setTimeout(() => {
			this.options.log(`idle ${idleMs}ms, detaching ${live.info.id}`);
			void this.stop(live.info.id).catch(() => {});
		}, idleMs);
		live.idleTimer.unref();
	}

	private clearIdle(live: LiveSession): void {
		if (live.idleTimer) clearTimeout(live.idleTimer);
		live.idleTimer = undefined;
	}

	private async scan(): Promise<Array<{ header: SessionHeader; path: string }>> {
		const results: Array<{ header: SessionHeader; path: string }> = [];
		let entries;
		try {
			entries = await readdir(this.options.sessionsDir, { recursive: true, withFileTypes: true });
		} catch {
			return results;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
			const path = join(entry.parentPath, entry.name);
			const header = await this.header(path);
			if (header) results.push({ header, path });
		}
		return results;
	}

	private async header(path: string): Promise<SessionHeader | undefined> {
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch {
			return undefined;
		}
		const cached = this.files.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.header;
		try {
			const head = await readHead(path, HEAD_BYTES);
			const headLines = head.text.split("\n");
			const firstLine = headLines[0] ?? "";
			if (firstLine.length === 0) return undefined;
			const parsed = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string; timestamp?: string };
			if (parsed.type !== "session" || !parsed.id) return undefined;

			// Names live in `session_info` records: the head pass covers the common
			// case, the bounded tail pass covers a rename later in the session.
			let name = nameFromLines(headLines.slice(0, NAME_HEAD_LINES));
			try {
				const tail = await readFromEnd(path, NAME_TAIL_BYTES);
				const tailLines = tail.text.split("\n");
				// A read that starts mid-file begins with a partial line.
				if (tail.offset > 0) tailLines.shift();
				name = nameFromLines(tailLines) ?? name;
			} catch {
				// Unreadable tail: keep whatever the head found.
			}

			const header: SessionHeader = {
				id: parsed.id,
				cwd: parsed.cwd ?? this.options.sessionsDir,
				timestamp: parsed.timestamp ?? new Date(mtimeMs).toISOString(),
				name,
			};
			this.files.set(path, { mtimeMs, header });
			return header;
		} catch {
			return undefined;
		}
	}
}

// ---------------------------------------------------------- coverage keys

/**
 * Coverage key for a live record: the message identity Pi also stores on the
 * entry. Streaming updates belong to the assistant message that last started or
 * ended; tool executions belong to that same message (they carry its calls).
 */
function coverageKey(target: LiveSession, record: { type?: string; message?: unknown }): string | undefined {
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

/** Coverage keys for a snapshot: one per entry that carries a message. */
export function coverageKeys(entries: unknown[]): string[] {
	const keys: string[] = [];
	for (const entry of entries) {
		const message = (entry as { message?: { role?: unknown; timestamp?: unknown } } | null)?.message;
		if (!message || typeof message.role !== "string" || typeof message.timestamp !== "number") continue;
		keys.push(`msg:${message.role}:${message.timestamp}`);
	}
	return keys;
}

// ------------------------------------------------------------ jsonl windows

function normalizeRecord(raw: unknown, fallbackCwd: string): SessionIndexRecord[] {
	if (!raw || typeof raw !== "object") return [];
	const record = raw as Partial<SessionIndexRecord>;
	if (typeof record.logicalId !== "string" || typeof record.piId !== "string") return [];
	const piIds = Array.isArray(record.piIds)
		? record.piIds.filter((id): id is string => typeof id === "string")
		: [];
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
function storedInfo(record: StoredSessionRecord, kind: "archive" | "trash", graceMs: number): StoredSessionInfo {
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
function safeName(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "session");
	return cleaned.slice(0, 120) || "session";
}

async function moveFile(from: string, to: string): Promise<void> {
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
async function uniquePath(path: string): Promise<string> {
	let candidate = path;
	const ext = path.endsWith(".jsonl") ? ".jsonl" : "";
	const base = ext ? path.slice(0, -ext.length) : path;
	for (let suffix = 1; await pathExists(candidate); suffix += 1) {
		candidate = `${base}.restored-${suffix}${ext}`;
	}
	return candidate;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}


/** First `maxBytes` of a file, decoded once (never a whole-session read). */
async function readHead(path: string, maxBytes: number): Promise<{ text: string }> {
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
async function readFromEnd(path: string, maxBytes: number): Promise<{ text: string; offset: number; size: number }> {
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
function nameFromLines(lines: string[]): string | undefined {
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
function transcriptEntries(entries: unknown[]): unknown[] {
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
			if (typeof copy[key] === "string") copy[key] = truncateText(copy[key] as string, limit);
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
	if (typeof copy["summary"] === "string") copy["summary"] = truncateText(copy["summary"] as string, limit);
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

/** Key used while a spawn is in flight, before `get_state` reports the real id. */
const SYMBOL_PENDING = "\u0000pending";

export function frameSessionList(infos: SessionInfo[]): string {
	return frameSessions(infos);
}

export function frameForSnapshot(
	info: SessionInfo,
	entries: unknown[],
	leafId: string | null,
): string {
	return frameSnapshot(info, entries, leafId);
}

export type { SessionInfo, SessionState };

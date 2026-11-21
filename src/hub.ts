import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { RpcChild } from "./rpc.ts";
import { frameError, frameEvent, frameFooter, frameModels, frameSessions, frameSnapshot, frameStatus } from "./wire.ts";
import type { FooterData, ModelSummary, SessionInfo, SessionState } from "./wire.ts";

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

interface HubOptions {
	piBin: string;
	sessionsDir: string;
	/** Plain JSON array mapping pixip logical ids to the Pi sessions they ran as. */
	indexPath: string;
	idleMs: number;
	extraPiArgs: string[];
	/** Extra environment for every child; `process.env` is inherited first. */
	env?: Record<string, string | undefined>;
	log: (message: string) => void;
}

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
	sessionFile?: string;
	createdAt: string;
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
	/** Timestamp of the assistant message currently streaming (or last done). */
	assistantTs?: number;
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
	/** Serializes index writes; every mutation is read-modify-write inside it. */
	private indexWrite: Promise<void> = Promise.resolve();

	constructor(options: HubOptions) {
		this.options = options;
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

	async prompt(id: string, text: string): Promise<void> {
		const live = this.require(id);
		this.touch(live);
		await live.proc.command({ type: "prompt", message: text });
	}

	async steer(id: string, text: string): Promise<void> {
		const live = this.require(id);
		this.touch(live);
		await live.proc.command({ type: "steer", message: text });
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
			env: { ...this.options.env, PIXIP_SESSION_ID: logicalId },
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

		this.live.delete(SYMBOL_PENDING);
		const previous = this.live.get(info.id);
		if (previous) await previous.proc.close();
		this.live.set(info.id, live);

		// Persist the logical -> Pi id mapping. A broken index must never take a
		// session down, so a failed write is only logged.
		await this.upsertIndex(info, logicalId, input.createdAt).catch((error: unknown) => {
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

	private async upsertIndex(info: SessionInfo, logicalId: string, createdAt?: string): Promise<void> {
		if (!info.id) return;
		await this.mutateIndex((records) => {
			const existing = records.find((record) => record.logicalId === logicalId);
			const piIds = existing ? [...existing.piIds] : [];
			if (!piIds.includes(info.id)) piIds.push(info.id);
			const next: SessionIndexRecord = {
				logicalId,
				piId: info.id,
				piIds,
				cwd: info.cwd,
				name: info.name ?? existing?.name,
				sessionFile: info.sessionFile ?? existing?.sessionFile,
				createdAt: existing?.createdAt ?? createdAt ?? new Date().toISOString(),
			};
			const index = records.findIndex((record) => record.logicalId === logicalId);
			return index >= 0 ? records.map((record, at) => (at === index ? next : record)) : [...records, next];
		});
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
	 * A rename of a never-prompted session exists only in memory, so persist it
	 * to the index. Once the JSONL exists, the file stays the source of truth.
	 */
	private async persistName(live: LiveSession): Promise<void> {
		const { info } = live;
		if (!info.logicalId) return;
		if (info.sessionFile && (await pathExists(info.sessionFile))) return;
		await this.upsertIndex(info, info.logicalId).catch((error: unknown) => {
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

	private touch(live: LiveSession): void {
		live.info.lastActivity = Date.now();
		this.clearIdle(live);
		if (live.info.state !== "busy") {
			live.info.state = "busy";
			this.emitStatus(live);
		}
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
			sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
			createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
		},
	];
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

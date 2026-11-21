import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
	idleMs: number;
	extraPiArgs: string[];
	log: (message: string) => void;
}

interface SessionHeader {
	id: string;
	cwd: string;
	timestamp: string;
}

interface LiveSession {
	proc: RpcChild;
	info: SessionInfo;
	subs: Set<(frame: string) => void>;
	idleTimer?: NodeJS.Timeout;
	branch?: string;
	footerTimer?: NodeJS.Timeout;
}

type Subscriber = (frame: string) => void;

const SESSION_FILE = /\.jsonl$/;

export class Hub {
	private readonly options: HubOptions;
	private readonly live = new Map<string, LiveSession>();
	private readonly files = new Map<string, { mtimeMs: number; header: SessionHeader }>();
	private readonly watchers = new Set<Subscriber>();

	constructor(options: HubOptions) {
		this.options = options;
	}

	// ---------------------------------------------------------------- listing

	async list(): Promise<SessionInfo[]> {
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
			infos.push({
				id: header.id,
				cwd: header.cwd,
				state: "stopped",
				sessionFile: path,
				lastActivity: Date.parse(header.timestamp) || 0,
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
			args: ["--mode", "rpc", "--session-dir", this.options.sessionsDir, ...(name ? ["--name", name] : [])],
		});
	}

	async attach(id: string): Promise<SessionInfo> {
		const existing = this.live.get(id);
		if (existing) return existing.info;
		const found = (await this.scan()).find((entry) => entry.header.id === id);
		if (!found) throw new Error(`unknown session ${id}`);
		return await this.spawn({ cwd: found.header.cwd, args: ["--mode", "rpc", "--session", found.path] });
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

	async snapshot(id: string): Promise<{ info: SessionInfo; entries: unknown[]; leafId: string | null }> {
		const live = this.require(id);
		const data = (await live.proc.command({ type: "get_entries" })) as {
			entries: unknown[];
			leafId: string | null;
		};
		return { info: live.info, entries: data.entries ?? [], leafId: data.leafId ?? null };
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

	private async spawn(input: { cwd: string; args: string[] }): Promise<SessionInfo> {
		const started = Date.now();
		let resolveState!: (info: SessionInfo) => void;
		let rejectState!: (error: Error) => void;
		const ready = new Promise<SessionInfo>((resolve, reject) => {
			resolveState = resolve;
			rejectState = reject;
		});

		const info: SessionInfo = {
			id: "",
			cwd: input.cwd,
			state: "starting",
			lastActivity: started,
		};

		const proc = new RpcChild({
			command: this.options.piBin,
			args: [...input.args, ...this.options.extraPiArgs],
			cwd: input.cwd,
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

		this.broadcast(target, frameEvent(raw));
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

	// --------------------------------------------------------------- plumbing

	private require(id: string): LiveSession {
		const live = this.live.get(id);
		if (!live) throw new Error(`session ${id} is not attached`);
		return live;
	}

	private broadcast(live: LiveSession, frame: string): void {
		for (const subscriber of live.subs) {
			try {
				subscriber(frame);
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
			const content = await readFile(path, "utf8");
			const firstLine = content.slice(0, content.indexOf("\n"));
			if (firstLine.length === 0) return undefined;
			const parsed = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string; timestamp?: string };
			if (parsed.type !== "session" || !parsed.id) return undefined;
			const header: SessionHeader = {
				id: parsed.id,
				cwd: parsed.cwd ?? this.options.sessionsDir,
				timestamp: parsed.timestamp ?? new Date(mtimeMs).toISOString(),
			};
			this.files.set(path, { mtimeMs, header });
			return header;
		} catch {
			return undefined;
		}
	}
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

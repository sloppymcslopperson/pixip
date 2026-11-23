// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Hub methods split by concern; each function runs with the Hub instance as `this`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type { RpcChild } from "./rpc.ts";
import { piRpcBackend, type PiBackend } from "./backend.ts";
import { type NameSource } from "./sessionIndex.ts";
import { isBlockingUiMethod, SYMBOL_PENDING, coverageKey } from "./jsonl.ts";
import { resolveSessionPolicy, type CommandLayer } from "./commands.ts";
import { messageText } from "./titles.ts";
import { frameError, frameEvent, frameFooter, frameRestarting, frameSessions, frameStatus } from "./wire.ts";
import type { CommandPolicy, FooterData, SessionInfo } from "./wire.ts";

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

export async function create(this: any, cwd: string, name?: string): Promise<SessionInfo> {
	return await this.spawn({
		cwd,
		logicalId: randomUUID(),
		args: ["--mode", "rpc", "--session-dir", this.options.sessionsDir, ...(name ? ["--name", name] : [])],
	});
}

export async function attach(this: any, id: string): Promise<SessionInfo> {
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

export async function stop(this: any, id: string): Promise<SessionInfo> {
	const live = this.live.get(id);
	if (!live) {
		const known = (await this.list()).find((info) => info.id === id);
		if (!known) throw new Error(`unknown session ${id}`);
		return known;
	}
	this.clearIdle(live);
	this.clearPendingUi(live);
	this.live.delete(id);
	live.info.state = "stopped";
	// Stopping must not drop a name that only the live session knows about.
	// Keep the index as the durable copy; the JSONL is authoritative when it
	// actually carries a session_info name.
	await this.persistName(live);
	await live.proc.close();
	this.emitStatus(live);
	this.broadcast(live, frameStatus(live.info));
	return live.info;
}

export function announceRestart(this: any): void {
	const frame = frameRestarting();
	for (const live of this.live.values()) this.broadcast(live, frame);
}

export async function shutdown(this: any): Promise<void> {
	await Promise.all([...this.live.keys()].map((id) => this.stop(id).catch(() => {})));
}

export async function spawn(
	this: any,
	input: {
		cwd: string;
		args: string[];
		logicalId?: string;
		createdAt?: string;
	},
): Promise<SessionInfo> {
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

	const host = this.options.piHostBin;
	const proc = (this.options.backend ?? piRpcBackend).create({
		command: host ?? this.options.piBin,
		// The host accepts the same session flags; extra Pi-only args belong to the
		// legacy child and would be rejected by the host's strict parser.
		args: host ? input.args : [...input.args, ...this.options.extraPiArgs],
		cwd: input.cwd,
		env: { ...this.options.env, PIXIP_SESSION_ID: logicalId, PIXIP_INSIDE: "1" },
		onRecord: (raw, record) => this.onRecord(info, raw, record),
		onStderr: (chunk) => this.options.log(`[${host ? "host" : "pi"} ${input.cwd}] ${chunk.trimEnd()}`),
		onExit: (code, signal) => {
			const live = this.live.get(info.id);
			if (live?.proc === proc) {
				this.live.delete(info.id);
				this.clearIdle(live);
				this.clearPendingUi(live);
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

	let state: {
		sessionId?: string;
		sessionFile?: string;
		sessionName?: string;
		model?: { id?: string };
		thinkingLevel?: string;
		messageCount?: number;
		isStreaming?: boolean;
	};
	try {
		state = (await proc.command({ type: "get_state" })) as typeof state;
	} catch (error) {
		// A child that never answered is not a session: drop the pending entry
		// and close the pipe so a failed create rejects instead of leaking it.
		this.live.delete(SYMBOL_PENDING);
		await proc.close().catch(() => {});
		throw error;
	}

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

export function onRecord(this: any, info: SessionInfo, raw: string, record: unknown): void {
	const live = this.live.get(info.id);
	const target = live ?? this.pendingSession(info);
	if (!target) return;
	const typed = record as {
		type?: string;
		id?: unknown;
		name?: string;
		message?: unknown;
		assistantMessageEvent?: { type?: string };
		method?: string;
		statusKey?: string;
		statusText?: unknown;
		widgetKey?: string;
		widgetLines?: unknown;
		widgetPlacement?: string;
		protocol?: number;
		piVersion?: string;
		capabilities?: unknown;
	};
	// Stamp the entry identity once, before the status bookkeeping below.
	const key = coverageKey(target, typed);

	switch (typed.type) {
		case "hello":
			// Protocol handshake, not transcript. Record it for diagnostics/replay tests
			// and never hand it to the client as an event.
			target.host = {
				...(typeof typed.protocol === "number" ? { protocol: typed.protocol } : {}),
				...(typeof typed.piVersion === "string" ? { piVersion: typed.piVersion } : {}),
				capabilities: Array.isArray(typed.capabilities)
					? typed.capabilities.filter((value): value is string => typeof value === "string")
					: [],
			};
			this.options.log(
				`pi host hello: protocol ${target.host.protocol ?? "?"} pi ${target.host.piVersion ?? "?"} [${target.host.capabilities?.join(", ") ?? ""}]`,
			);
			return;
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
			if (target.titleAwaitingMessage) {
				// No expanded user message (for example an extension command that
				// only notified): fall back to the command text once the run settles.
				const prompt = target.titlePrompt;
				target.titleAwaitingMessage = false;
				target.titlePrompt = undefined;
				if (prompt && !target.info.name) void this.autoLabel(target, prompt, true);
			}
			if (target.titlePending) {
				const prompt = target.titlePending;
				target.titlePending = undefined;
				if (!target.info.name) void this.autoLabel(target, prompt, true);
			}
			break;
		case "session_info_changed":
			if (target.info.name !== typed.name) target.nameSource = "manual";
			target.info.name = typed.name;
			this.emitStatus(target);
			void this.persistName(target);
			break;
		case "message_start": {
			const message = typed.message as { role?: string } | undefined;
			// A slash command's result arrives as the first user message, already
			// expanded by Pi. Its text is the prompt the model sees, so label that.
			if (message?.role === "user" && target.titleAwaitingMessage && !target.info.name) {
				target.titleAwaitingMessage = false;
				const prompt = messageText(message).trim() || target.titlePrompt || "";
				target.titlePrompt = undefined;
				if (prompt) void this.autoLabel(target, prompt);
			}
			break;
		}
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
		case "extension_ui_request":
			this.cacheAddonUi(target, typed, raw);
			this.cacheBlockingUi(target, typed, raw);
			break;
		default:
			break;
	}

	this.broadcast(target, frameEvent(raw), key);
}

export function cacheBlockingUi(
	this: any,
	live: LiveSession,
	request: { id?: unknown; method?: string },
	raw: string,
): void {
	if (!isBlockingUiMethod(request.method)) return;
	const id = typeof request.id === "string" ? request.id : "";
	if (!id) return;
	live.pendingUi ??= new Map();
	this.clearPendingUi(live, id);
	const pending: PendingUiRequest = { frame: frameEvent(raw) };
	live.pendingUi.set(id, pending);
	if (live.subs.size === 0) this.armPendingUiTimer(live, pending);
}

export function armPendingUiTimers(this: any, live: LiveSession): void {
	for (const pending of live.pendingUi?.values() ?? []) this.armPendingUiTimer(live, pending);
}

export function armPendingUiTimer(this: any, live: LiveSession, pending: PendingUiRequest): void {
	if (this.pendingUiGraceMs <= 0 || pending.timer) return;
	for (const [id, entry] of live.pendingUi ?? []) {
		if (entry !== pending) continue;
		pending.timer = setTimeout(() => {
			pending.timer = undefined;
			if (live.subs.size > 0 || live.pendingUi?.get(id) !== pending) return;
			live.pendingUi.delete(id);
			this.options.log(`ui request ${id} has no client; cancelling it so pi can settle`);
			try {
				live.proc.send({ type: "extension_ui_response", id, cancelled: true });
			} catch (error) {
				this.options.log(`ui request ${id} cancel failed: ${(error as Error).message}`);
			}
		}, this.pendingUiGraceMs);
		pending.timer.unref();
		return;
	}
}

export function clearPendingUi(this: any, live: LiveSession, id?: string): void {
	if (!live.pendingUi) return;
	if (id !== undefined) {
		const pending = live.pendingUi.get(id);
		if (pending) this.clearPendingUiTimer(pending);
		live.pendingUi.delete(id);
		return;
	}
	for (const pending of live.pendingUi.values()) this.clearPendingUiTimer(pending);
	live.pendingUi.clear();
}

export function clearPendingUiTimer(this: any, pending: PendingUiRequest): void {
	if (!pending.timer) return;
	clearTimeout(pending.timer);
	pending.timer = undefined;
}

export function cacheAddonUi(
	this: any,
	live: LiveSession,
	request: {
		method?: string;
		statusKey?: string;
		statusText?: unknown;
		widgetKey?: string;
		widgetLines?: unknown;
		widgetPlacement?: string;
	},
	raw: string,
): void {
	if (request.method !== "setStatus" && request.method !== "setWidget") return;
	live.addonUi ??= { statuses: new Map(), widgets: new Map() };
	if (request.method === "setStatus") {
		const key = request.statusKey;
		if (typeof key !== "string" || key.length === 0) return;
		if (typeof request.statusText === "string" && request.statusText.length > 0) {
			live.addonUi.statuses.set(key, raw);
		} else {
			live.addonUi.statuses.delete(key);
		}
		return;
	}
	const key = request.widgetKey;
	if (typeof key !== "string" || key.length === 0) return;
	const lines = Array.isArray(request.widgetLines)
		? request.widgetLines.filter((line): line is string => typeof line === "string")
		: [];
	if (lines.length === 0) {
		live.addonUi.widgets.delete(key);
		return;
	}
	live.addonUi.widgets.set(key, {
		placement: request.widgetPlacement === "belowEditor" ? "below" : "above",
		frame: raw,
	});
}

export function pendingSession(this: any, info: SessionInfo): LiveSession | undefined {
	const candidate = this.live.get(SYMBOL_PENDING);
	return candidate && candidate.info === info ? candidate : undefined;
}

export async function footer(this: any, id: string): Promise<FooterData> {
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

export async function sendFooter(this: any, live: LiveSession): Promise<void> {
	try {
		this.broadcast(live, frameFooter(await this.footer(live.info.id)));
	} catch {
		// a session that is mid-shutdown has no footer to send
	}
}

export function scheduleFooter(this: any, live: LiveSession): void {
	if (live.footerTimer) return;
	live.footerTimer = setTimeout(() => {
		live.footerTimer = undefined;
		void this.sendFooter(this.live.get(live.info.id) ?? live);
	}, 150);
}

export function require(this: any, id: string): LiveSession {
	const live = this.live.get(id);
	if (!live) throw new Error(`session ${id} is not attached`);
	return live;
}

export function broadcast(this: any, live: LiveSession, frame: string, key?: string): void {
	for (const subscriber of live.subs) {
		try {
			subscriber(frame, key);
		} catch {
			live.subs.delete(subscriber);
		}
	}
}

export function emitStatus(this: any, live: LiveSession): void {
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

export function broadcastList(this: any, infos: SessionInfo[]): void {
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

export function touch(this: any, live: LiveSession): void {
	live.info.lastActivity = Date.now();
	this.clearIdle(live);
}

export function scheduleIdle(this: any, live: LiveSession): void {
	const { idleMs } = this.options;
	if (idleMs <= 0) return;
	this.clearIdle(live);
	live.idleTimer = setTimeout(() => {
		this.options.log(`idle ${idleMs}ms, detaching ${live.info.id}`);
		void this.stop(live.info.id).catch(() => {});
	}, idleMs);
	live.idleTimer.unref();
}

export function clearIdle(this: any, live: LiveSession): void {
	if (live.idleTimer) clearTimeout(live.idleTimer);
	live.idleTimer = undefined;
}

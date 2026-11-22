// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Hub methods split by concern; each function runs with the Hub instance as `this`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { RpcChild } from "./rpc.ts";
import { piRpcBackend, type PiBackend } from "./backend.ts";
import { MAX_UPLOAD_BYTES, normalizeImageAttachments, safeUploadName } from "./attachments.ts";
import {
	type NameSource,
	type SessionHeader,
	type SessionIndexRecord,
	type StoredSessionInfo,
	type StoredSessionRecord,
	type SessionTarget,
	normalizeRecord,
	safeName,
	storedInfo,
} from "./sessionIndex.ts";
import {
	ENTRY_TEXT_LIMIT,
	WINDOW_BYTES,
	WINDOW_ENTRIES,
	moveFile,
	nameFromLines,
	parseEntries,
	pathExists,
	readFromEnd,
	readHead,
	transcriptEntries,
	truncateEntries,
	uniquePath,
	isBlockingUiMethod,
	SYMBOL_PENDING,
	coverageKey,
	coverageKeys,
} from "./jsonl.ts";
import { resolveSessionPolicy, type CommandLayer } from "./commands.ts";
import { resolveModelArgument, resolveThinkingArgument } from "./client/commands.js";
import { exportFileName } from "./client/sessionInfo.js";
import { fallbackTitle, normalizeTitle, titlePrompt } from "./titles.ts";
import {
	frameError,
	frameEvent,
	frameFooter,
	framePolicy,
	frameRestarting,
	frameSessions,
	frameSnapshot,
	frameStatus,
} from "./wire.ts";
import type {
	BashResult,
	CommandPolicy,
	DynamicCommand,
	FooterData,
	ModelSummary,
	SessionInfo,
	SessionState,
} from "./wire.ts";

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
	/** Unanswered select/confirm/input/editor requests, replayed on reattach. */
	pendingUi?: Map<string, PendingUiRequest>;
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

export async function models(this: any, id: string): Promise<{ models: ModelSummary[]; current: string | null }> {
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

export async function setModel(this: any, id: string, provider: string, modelId: string): Promise<void> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "set_model", provider, modelId })) as {
		id?: string;
		provider?: string;
	};
	live.info.model = data.id ?? modelId;
	this.emitStatus(live);
	await this.sendFooter(live);
}

export async function commands(this: any, id: string): Promise<DynamicCommand[]> {
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

export async function thinkingLevels(this: any, id: string): Promise<{ levels: string[]; current: string }> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "get_available_thinking_levels" })) as { levels?: string[] };
	return { levels: data.levels ?? ["off"], current: live.info.thinkingLevel ?? "off" };
}

export async function setThinking(this: any, id: string, level: string): Promise<void> {
	const live = this.require(id);
	await live.proc.command({ type: "set_thinking_level", level });
	live.info.thinkingLevel = level;
	this.emitStatus(live);
	await this.sendFooter(live);
}

export async function setThinkingQuery(this: any, id: string, query: string): Promise<void> {
	const { levels } = await this.thinkingLevels(id);
	const resolved = resolveThinkingArgument(levels, query) as {
		level?: string;
		error?: string;
	};
	if (!resolved.level) throw new Error(resolved.error ?? `unknown thinking level "${query}"`);
	await this.setThinking(id, resolved.level);
}

export async function setModelQuery(this: any, id: string, query: string): Promise<void> {
	const { models } = await this.models(id);
	const resolved = resolveModelArgument(models, query) as {
		model?: { id: string; provider: string };
		error?: string;
	};
	if (!resolved.model) throw new Error(resolved.error ?? `unknown model "${query}"`);
	await this.setModel(id, resolved.model.provider, resolved.model.id);
}

export async function setName(this: any, id: string, name: string, source: NameSource = "manual"): Promise<void> {
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

export async function autoLabel(this: any, live: LiveSession, prompt: string, retry = false): Promise<void> {
	let title = "";
	try {
		const model = await this.resolveTitleModel(live);
		title = normalizeTitle(await this.runTitlePi(live, prompt, model));
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		const detail = typeof stderr === "string" ? stderr.trim().slice(0, 500) : "";
		this.options.log(
			`auto title failed for ${live.info.id}: ${(error as Error).message}${detail ? ` (${detail})` : ""}`,
		);
	}
	// The title call shares the provider with the first turn. If it loses that
	// race, wait for `agent_settled` and try once more before using local words.
	if (!title && !retry && live.info.state === "busy" && !live.info.name) {
		live.titlePending = prompt;
		return;
	}
	if (!title) title = fallbackTitle(prompt);
	if (!title || this.live.get(live.info.id) !== live || live.info.name) return;
	try {
		await this.setName(live.info.id, title, "auto");
	} catch (error) {
		this.options.log(`auto title apply failed for ${live.info.id}: ${(error as Error).message}`);
	}
}

export async function resolveTitleModel(this: any, live: LiveSession): Promise<string | undefined> {
	const requested = this.options.titleModel?.trim();
	let models: ModelSummary[] = [];
	try {
		models = (await this.models(live.info.id)).models;
	} catch {
		// A session with no model discovery still gets the configured id.
	}
	const resolve = (query: string): ModelSummary | undefined => {
		const result = resolveModelArgument(models, query) as { model?: ModelSummary };
		return result.model;
	};
	const sessionModel =
		models.find((model) => model.id === live.info.model) ?? (models.length === 1 ? models[0] : undefined);
	const chosen = requested ? (resolve(requested) ?? sessionModel) : sessionModel;
	if (!chosen) return requested || live.info.model || undefined;
	return chosen.provider ? `${chosen.provider}/${chosen.id}` : chosen.id;
}

export async function runTitlePi(this: any, live: LiveSession, prompt: string, model?: string): Promise<string> {
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
	return await new Promise<string>((resolve, reject) => {
		const child = execFile(
			this.options.piBin,
			args,
			{
				cwd: live.info.cwd,
				env: { ...process.env, ...this.options.env },
				timeout: this.options.titleTimeoutMs ?? 15_000,
				maxBuffer: 256 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					// Keep the child's diagnostic tail for the hub log; execFile's own
					// message only repeats the command line.
					(error as Error & { stderr?: string }).stderr = stderr;
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
		// Pi's print mode waits for stdin EOF before it starts. `execFile` leaves
		// a pipe open, so every title call used to sit there until the timeout.
		child.stdin?.end();
	});
}

export async function compact(this: any, id: string, instructions?: string): Promise<void> {
	const live = this.require(id);
	await live.proc.command(
		{ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) },
		{ timeoutMs: 0 },
	);
	// The context window and token totals changed; the footer must follow.
	await this.sendFooter(live);
}

export async function lastAssistantText(this: any, id: string): Promise<string | null> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "get_last_assistant_text" })) as { text?: string | null } | null;
	return typeof data?.text === "string" ? data.text : null;
}

export async function tree(this: any, id: string): Promise<{ tree: unknown[]; leafId: string | null }> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "get_tree" })) as { tree?: unknown; leafId?: unknown } | null;
	return {
		tree: Array.isArray(data?.tree) ? data.tree : [],
		leafId: typeof data?.leafId === "string" ? data.leafId : null,
	};
}

export async function fork(
	this: any,
	id: string,
	entryId: string,
): Promise<{ text: string | null; cancelled: boolean }> {
	const live = this.require(id);
	if (!entryId) throw new Error("fork needs a user-message entry id");
	const data = (await live.proc.command(
		{ type: "fork", entryId },
		{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
	)) as { text?: unknown; cancelled?: unknown } | null;
	if (data?.cancelled) return { text: null, cancelled: true };
	await this.rekeyFromState(live);
	return { text: typeof data?.text === "string" ? data.text : null, cancelled: false };
}

export async function clone(this: any, id: string): Promise<{ cancelled: boolean }> {
	const live = this.require(id);
	const data = (await live.proc.command({ type: "clone" }, { timeoutMs: this.options.promptTimeoutMs ?? 0 })) as {
		cancelled?: unknown;
	} | null;
	if (data?.cancelled) return { cancelled: true };
	await this.rekeyFromState(live);
	return { cancelled: false };
}

export async function importSession(
	this: any,
	id: string,
	sourcePath: string,
): Promise<{ info: SessionInfo; cancelled: boolean }> {
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
	const stamp = (typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString()).replace(
		/[:.]/g,
		"-",
	);
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
	const result =
		((await live.proc.command(
			{ type: "switch_session", sessionPath: target },
			{ timeoutMs: this.options.promptTimeoutMs ?? 0 },
		)) as { cancelled?: boolean } | null) ?? {};
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

export function exportsDir(this: any): string {
	return join(this.options.dataDir ?? dirname(this.options.sessionsDir), "exports");
}

export async function exportHtml(this: any, id: string): Promise<string> {
	const live = this.require(id);
	const dir = this.exportsDir();
	await mkdir(dir, { recursive: true });
	const requested = join(dir, exportFileName(live.info, "html"));
	const data = (await live.proc.command({ type: "export_html", outputPath: requested })) as { path?: unknown } | null;
	const written = typeof data?.path === "string" ? data.path : requested;
	this.exported.set(live.info.id, written);
	return written;
}

export async function exportedHtml(this: any, id: string): Promise<string> {
	return this.exported.get(id) ?? (await this.exportHtml(id));
}

export async function sessionFile(this: any, id: string): Promise<string | undefined> {
	return await this.sessionPath(id);
}

export async function newSession(this: any, id: string): Promise<SessionInfo> {
	const live = this.require(id);
	const result =
		((await live.proc.command({ type: "new_session" }, { timeoutMs: this.options.promptTimeoutMs ?? 0 })) as {
			cancelled?: boolean;
		} | null) ?? {};
	if (result.cancelled) throw new Error("new session was cancelled by an extension");
	await this.clearUploads(live.info.logicalId ?? live.info.id);
	return await this.rekeyFromState(live);
}

export async function rekeyFromState(this: any, live: LiveSession): Promise<SessionInfo> {
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

export function onRekey(this: any, listener: (from: string, info: SessionInfo) => void): () => void {
	this.rekeyListeners.add(listener);
	return () => this.rekeyListeners.delete(listener);
}

export function uiResponse(this: any, id: string, requestId: string, fields: Record<string, unknown>): void {
	const live = this.require(id);
	this.clearPendingUi(live, requestId);
	live.proc.send({ type: "extension_ui_response", id: requestId, ...fields });
}

export function addonUiFrames(this: any, id: string): string[] {
	const cache = this.live.get(id)?.addonUi;
	if (!cache) return [];
	const frames: string[] = [];
	for (const widget of cache.widgets.values()) {
		if (widget.placement === "above") frames.push(frameEvent(widget.frame));
	}
	for (const frame of cache.statuses.values()) frames.push(frameEvent(frame));
	for (const widget of cache.widgets.values()) {
		if (widget.placement === "below") frames.push(frameEvent(widget.frame));
	}
	return frames;
}

export function subscribe(this: any, id: string, subscriber: Subscriber): () => void {
	const live = this.live.get(id);
	if (!live) return () => {};
	live.subs.add(subscriber);
	// Replay after adding: records that arrive from now on go through
	// `broadcast`, and anything cached before this call is delivered here. No
	// gap, no duplicate, and a reloaded browser gets the dialog back.
	for (const pending of live.pendingUi?.values() ?? []) {
		this.clearPendingUiTimer(pending);
		try {
			subscriber(pending.frame);
		} catch {
			live.subs.delete(subscriber);
			break;
		}
	}
	return () => {
		live.subs.delete(subscriber);
		if (live.subs.size === 0) this.armPendingUiTimers(live);
	};
}

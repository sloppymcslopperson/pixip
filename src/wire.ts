/**
 * Hub <-> browser wire protocol, version 1.
 *
 * The only hard rule: `event` frames carry Pi's RPC record *verbatim*. The hub
 * never parses an event to forward it; it splices the original JSON text into a
 * one-field envelope. That keeps the hot path allocation-free-ish here and maps
 * to `serde_json::value::RawValue` in Rust without a translation layer.
 */

import type { InboxSummary } from "./inbox.ts";

export const WIRE_VERSION = 1;

/** Everything the TUI footer shows, unformatted: the client formats it. */
export interface FooterData {
	cwd: string;
	home: string;
	branch?: string;
	name?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	context: { percent: number | null; window: number };
	autoCompact: boolean;
	model: { id: string; provider: string; reasoning: boolean } | null;
	thinking: string;
	providerCount: number;
}

/**
 * Restrict-only command policy, resolved per session from the data dir, the
 * session cwd and the CLI flags. `allow: []` means "no allow restriction";
 * `deny` wins over `allow`; `bash: false` disables `!`/`!!`.
 */
export interface CommandPolicy {
	allow: string[];
	deny: string[];
	bash: boolean;
}

/** Final result of one `!`/`!!` command, built by the hub from the RPC response. */
export interface BashResult {
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface ModelSummary {
	id: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
}

/** One live command from Pi's `get_commands` (extension, prompt or skill). */
export interface DynamicCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export type SessionState = "starting" | "idle" | "busy" | "stopped" | "error";

/** A linked git worktree a session runs in; absent for main-repo and plain dirs. */
export interface WorktreeInfo {
	/** Absolute main repository root. */
	repo: string;
	/** Absolute worktree root (even when the session cwd is a subdirectory). */
	path: string;
	/** Full git branch name, e.g. `pixip/fix-reconnect`. */
	branch: string;
	/** True when pixip created or mounted a session in this worktree. */
	pixipActive: boolean;
}

/** Another live session in the same realpath cwd. */
export interface SessionPeer {
	/** Stable pixip logical id. */
	id: string;
	name: string;
}

export interface SessionInfo {
	id: string;
	/** Stable pixip id for the logical session; survives Pi allocating a new id. */
	logicalId?: string;
	cwd: string;
	name?: string;
	state: SessionState;
	model?: string;
	thinkingLevel?: string;
	messageCount?: number;
	sessionFile?: string;
	/** Current git branch (or detached short SHA) for the dashboard chip. */
	branch?: string;
	/** Main repository root for any git session, including main-repo and worktrees. */
	repo?: string;
	/** Linked worktree metadata; absent for main-repo and plain directories. */
	worktree?: WorktreeInfo;
	/** Other live sessions sharing this realpath cwd; refreshed on lifecycle changes. */
	peers?: SessionPeer[];
	/** Excluded from the dashboard bulk archive; set by the session itself or a user. */
	protected?: boolean;
	lastActivity: number;
}

/** `{"t":"event","ev":<raw pi record>}` with no re-encoding. */
export function frameEvent(raw: string): string {
	return `{"t":"event","ev":${raw}}`;
}

export function frameSessions(sessions: SessionInfo[]): string {
	return JSON.stringify({ t: "sessions", v: WIRE_VERSION, sessions });
}

export function frameSnapshot(
	session: SessionInfo,
	entries: unknown[],
	leafId: string | null,
	more = false,
	resume = false,
	replace = false,
): string {
	// `more` means older entries exist before `entries[0]`; the client offers
	// "load earlier" and asks for the previous window with an `earlier` frame.
	// `resume` marks a cursor delta the client appends instead of replacing.
	// `replace` is a full window the client must adopt as-is (`resnapshot` after
	// a compaction or a `/new` session): pre-compaction windows are dropped.
	const frame: Record<string, unknown> = { t: "snapshot", session, entries, leafId, more };
	if (resume) frame["resume"] = true;
	if (replace) frame["replace"] = true;
	return JSON.stringify(frame);
}

/** A reconnect's live thought, derived from the hub buffer (attach path only). */
export function frameLiveThinking(thought: { text: string; active: boolean }): string {
	return JSON.stringify({ t: "live_thinking", text: thought.text, active: thought.active });
}

/** A blocking request is about to expire; ask the user whether to keep it. */
export function frameNeedTime(id: string, method: string, title: string, timeoutMs: number): string {
	return JSON.stringify({ t: "ui_need_time", id, method, title, timeoutMs });
}

/** Give the restored panel a draft saved when a timed-out panel was shelved. */
export function framePanelDraft(id: string, draft: unknown): string {
	return JSON.stringify({ t: "panel_draft", id, draft });
}

/** A blocking request expired; the client must drop its surface without answering. */
export function frameUiTimeout(id: string): string {
	return JSON.stringify({ t: "ui_timeout", id });
}

/** A timed-out request recorded for a possible re-ask after resume. */
export function frameReask(request: unknown): string {
	return JSON.stringify({ t: "reasks", requests: [request] });
}

/** One older window of entries, answering an `earlier` frame. */
export function frameHistory(entries: unknown[], more: boolean): string {
	return JSON.stringify({ t: "history", entries, more });
}

/**
 * Answer to `entry`: one full entry from the JSONL for lazy expansion, or the
 * id plus an error while the entry is still only in the live child's memory.
 */
export function frameEntry(id: string, entry: unknown, error?: string): string {
	return JSON.stringify({ t: "entry", id, entry, ...(error ? { error } : {}) });
}

/** Answer to `/tree`: Pi's read-only session tree and the current leaf id. */
export function frameTree(tree: unknown[], leafId: string | null): string {
	return JSON.stringify({ t: "tree", tree, leafId });
}

/** Answer to `/fork`: the forked-from text, or a cancellation. */
export function frameFork(text: string | null, cancelled: boolean): string {
	return JSON.stringify({ t: "fork", text, cancelled });
}

/** Answer to `/clone`. */
export function frameClone(cancelled: boolean): string {
	return JSON.stringify({ t: "clone", cancelled });
}

/** Answer to `/import`; the new session itself arrives as an `opened` frame. */
export function frameImport(cancelled: boolean): string {
	return JSON.stringify({ t: "import", cancelled });
}

/** Answer to `/export`: download URLs for the HTML and (when a file exists) JSONL. */
export function frameExport(html: string, jsonl: string | null): string {
	return JSON.stringify({ t: "export", html, jsonl });
}

export function frameStatus(session: SessionInfo): string {
	return JSON.stringify({ t: "status", session });
}

export function frameError(message: string): string {
	return JSON.stringify({ t: "error", message });
}

/** The old daemon tells live sockets it is being replaced before it closes. */
export function frameRestarting(): string {
	return JSON.stringify({ t: "restarting" });
}

export function frameFooter(footer: FooterData): string {
	return JSON.stringify({ t: "footer", footer });
}

export function frameModels(models: ModelSummary[], current: string | null): string {
	return JSON.stringify({ t: "models", models, current });
}

export function frameThinking(levels: string[], current: string): string {
	return JSON.stringify({ t: "thinking", levels, current });
}

/**
 * Live commands for the `/` menu (06). Sent once per attach and cached by the
 * client; a soft refresh reloads the page, which reattaches and refetches.
 */
export function frameCommands(commands: DynamicCommand[]): string {
	return JSON.stringify({ t: "commands", commands });
}

export function frameHello(sessions: SessionInfo[], defaultCwd?: string, home?: string): string {
	return JSON.stringify({ t: "hello", v: WIRE_VERSION, sessions, defaultCwd, home });
}

/** Badge frame for the dashboard: unread count, cap state and newest summary. */
export function frameInbox(inbox: InboxSummary): string {
	return JSON.stringify({ t: "inbox", inbox });
}

/**
 * The socket's session now has a new Pi id (`new_session`), so every tab
 * following it must re-key. `rekey` distinguishes this from the index-only
 * attach reply, which is followed by the hub's own snapshot.
 */
export function frameOpened(session: SessionInfo, rekey = false): string {
	return JSON.stringify({ t: "opened", session, ...(rekey ? { rekey: true } : {}) });
}

/** Answer to a `copy` frame: the last assistant text (Pi may return `null`). */
export function frameCopy(text: string | null): string {
	return JSON.stringify({ t: "copy", text });
}

export function framePolicy(policy: CommandPolicy): string {
	return JSON.stringify({ t: "policy", policy });
}

/**
 * Answer to a `clear_queue` frame: the texts Pi removed, so the client can
 * restore them into the composer (the TUI's Esc behaviour).
 */
export function frameQueue(steering: string[], followUp: string[]): string {
	return JSON.stringify({ t: "queue", steering, followUp });
}

/**
 * Terminal `bash` frame. `id` is the client-generated id also used for the RPC
 * command, so streamed `bash_execution_update` events and this result agree
 * without the hub parsing event payloads.
 */
export function frameBash(id: string, command: string, excludeFromContext: boolean, result: BashResult): string {
	return JSON.stringify({
		t: "bash",
		id,
		command,
		excludeFromContext,
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
	});
}

/** A refused or failed bash (already running, policy, child died). */
export function frameBashError(id: string, command: string, message: string): string {
	return JSON.stringify({ t: "bash", id, command, error: message });
}

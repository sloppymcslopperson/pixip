/**
 * Hub <-> browser wire protocol, version 1.
 *
 * The only hard rule: `event` frames carry Pi's RPC record *verbatim*. The hub
 * never parses an event to forward it; it splices the original JSON text into a
 * one-field envelope. That keeps the hot path allocation-free-ish here and maps
 * to `serde_json::value::RawValue` in Rust without a translation layer.
 */

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

export type SessionState = "starting" | "idle" | "busy" | "stopped" | "error";

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

/** One older window of entries, answering an `earlier` frame. */
export function frameHistory(entries: unknown[], more: boolean): string {
	return JSON.stringify({ t: "history", entries, more });
}

export function frameStatus(session: SessionInfo): string {
	return JSON.stringify({ t: "status", session });
}

export function frameError(message: string): string {
	return JSON.stringify({ t: "error", message });
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

export function frameHello(sessions: SessionInfo[], defaultCwd?: string): string {
	return JSON.stringify({ t: "hello", v: WIRE_VERSION, sessions, defaultCwd });
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

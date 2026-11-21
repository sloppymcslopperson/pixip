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
): string {
	// `more` means older entries exist before `entries[0]`; the client offers
	// "load earlier" and asks for the previous window with an `earlier` frame.
	return JSON.stringify({ t: "snapshot", session, entries, leafId, more });
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

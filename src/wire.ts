/**
 * Hub <-> browser wire protocol, version 1.
 *
 * The only hard rule: `event` frames carry Pi's RPC record *verbatim*. The hub
 * never parses an event to forward it; it splices the original JSON text into a
 * one-field envelope. That keeps the hot path allocation-free-ish here and maps
 * to `serde_json::value::RawValue` in Rust without a translation layer.
 */

export const WIRE_VERSION = 1;

export type SessionState = "starting" | "idle" | "busy" | "stopped" | "error";

export interface SessionInfo {
	id: string;
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

export function frameSnapshot(session: SessionInfo, entries: unknown[], leafId: string | null): string {
	return JSON.stringify({ t: "snapshot", session, entries, leafId });
}

export function frameStatus(session: SessionInfo): string {
	return JSON.stringify({ t: "status", session });
}

export function frameError(message: string): string {
	return JSON.stringify({ t: "error", message });
}

export function frameHello(sessions: SessionInfo[], defaultCwd?: string): string {
	return JSON.stringify({ t: "hello", v: WIRE_VERSION, sessions, defaultCwd });
}

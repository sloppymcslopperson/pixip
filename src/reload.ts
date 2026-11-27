import type { PauseResumeReport } from "./reload/pause.ts";

/** One reason `/reload` refused to touch the daemon. */
export interface ReloadBlocker {
	id: string;
	name?: string;
	reason: string;
}

/**
 * Daemon-code reload seam supplied by `bin/pixip.ts`. Server reload calls it
 * before any asset/policy change so a broken import never half-swaps the daemon.
 */
export interface ReloadCode {
	/** The generation currently serving. */
	generation: number;
	/** Non-reloadable inputs that changed since startup, if any. */
	requiresRestart(): string | undefined;
	/** Import the next generation without touching live state. */
	prepare(): Promise<{ generation: number }>;
	/** Swap the hub prototype and the server implementation. */
	applyPending(): void;
	/** Commit the applied generation and return its number. */
	commit(): number;
	/** Put the previous generation back after a failed attempt. */
	rollback(): void;
	/** Drop an imported generation that was never applied. */
	discard(): void;
}

/** Per-child outcome after the asset/policy swap has committed. */
export interface ReloadChildResult {
	id: string;
	name?: string;
	ok: boolean;
	/** A system-pi child replaced by the daemon's current host configuration. */
	migrated?: boolean;
	error?: string;
}

/**
 * The result of one daemon-wide reload. `refused` and `error` are preflight
 * failures with no side effects; `partial` means the assets/policy committed but
 * at least one child failed to reload.
 */
export interface ReloadReport {
	ok: boolean;
	status: "ok" | "refused" | "partial" | "error";
	message: string;
	blockers: ReloadBlocker[];
	children: ReloadChildResult[];
	reloaded: string[];
	reloads: number;
	/** Daemon code generation after a successful reload. */
	generation?: number;
	/** A non-reloadable change (entry/flags/options) that still needs a restart. */
	requiresRestart?: string;
	/** Opt-in pause/resume outcome for a paused reload. */
	pause?: PauseResumeReport;
}

/** One reason `/reload` refused to touch the daemon. */
export interface ReloadBlocker {
	id: string;
	name?: string;
	reason: string;
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
}

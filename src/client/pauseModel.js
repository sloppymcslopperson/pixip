// Pure model for the opt-in pause/resume UI: the confirm-card actions, the
// post-operation report row text, and the one-shot claim that keeps a restart's
// report from being painted twice after a reconnect. No DOM here, so `test/`
// covers it directly.
export const PAUSE_LABEL = "Pause and resume sessions";

/** Names for the card's plan line; empty when there is nothing to pause. */
export function pauseTargetsText(blockers) {
	const list = Array.isArray(blockers) ? blockers : [];
	return list
		.map((blocker) => {
			const name = typeof blocker?.name === "string" && blocker.name ? blocker.name : String(blocker?.id ?? "");
			const reason = typeof blocker?.reason === "string" && blocker.reason ? ` (${blocker.reason})` : "";
			return `${name}${reason}`;
		})
		.filter((entry) => entry.length > 0)
		.join(", ");
}

/** The action label for a refusal card: restart forces, reload opts in to pause. */
export function pauseConfirmAction(kind) {
	return kind === "reload" ? "Pause & reload" : "Force restart";
}

/** Buttons after a pause request timed out; reload can wait or cancel, restart forces. */
export function pauseTimeoutActions(kind) {
	if (kind === "reload") {
		return [
			{ id: "wait", label: "Wait longer" },
			{ id: "cancel-keep", label: "Cancel current reload (keep pause requests)" },
			{ id: "cancel-remove", label: "Cancel current reload (remove pending pause requests)" },
		];
	}
	return [{ id: "force", label: "Force restart anyway" }];
}

/** One ephemeral row for resumed and skipped sessions; null when there is nothing. */
export function pauseResultText(report) {
	if (!report || typeof report !== "object") return null;
	const resumed = Array.isArray(report.resumed) ? report.resumed.filter(Boolean) : [];
	const skipped = Array.isArray(report.skipped) ? report.skipped : [];
	if (resumed.length === 0 && skipped.length === 0) return null;
	const parts = [];
	if (resumed.length > 0) parts.push(`resumed ${resumed.join(", ")}`);
	if (skipped.length > 0) {
		const names = skipped
			.map((entry) => {
				const name = typeof entry?.name === "string" && entry.name ? entry.name : String(entry?.id ?? "");
				return `${name} (${String(entry?.reason ?? "skipped")})`;
			})
			.join(", ");
		parts.push(`skipped ${names}`);
	}
	return `pause/resume: ${parts.join("; ")}`;
}

/** Stable storage key for one daemon's pause report. */
export function pauseResultKey(pid, at) {
	return `pixip.pauseResult.${String(pid ?? "?")}.${String(at ?? "?")}`;
}

/** True exactly once per key; a storage failure never throws and never claims. */
export function claimPauseResult(storage, key) {
	try {
		if (storage.getItem(key)) return false;
		storage.setItem(key, "1");
		return true;
	} catch {
		return false;
	}
}

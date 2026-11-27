// `/pixup-restart` browser side: nonce-gated request, inline force/pause card, and
// the post-reconnect daemon notice. The row is local UI only; it is never sent to
// Pi or written to JSONL.
import { appendPauseTimeoutCard, appendReloadNotice, appendRestartCard } from "./transcript.js";
import { reloadNonce, sendPauseCancel, sendReload } from "./reload.js";
import {
	claimPauseResult,
	pauseConfirmAction,
	pauseResultKey,
	pauseResultText,
	pauseTargetsText,
	pauseTimeoutActions,
} from "./pauseModel.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { toast } from "./toast.js";

const PENDING_KEY = "pixip.restart.pending";

function formatUptime(ms) {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Ask the daemon to replace itself; force and pause are the card's second step. */
export function sendRestart(force = false, options = {}) {
	if (!state.sessionId) return;
	const value = reloadNonce();
	if (!value) {
		toast("restart is unavailable on this page; refresh it first");
		return;
	}
	send({
		t: "restart",
		nonce: value,
		...(force ? { force: true } : {}),
		...(options.pause ? { pause: true } : {}),
		...(options.now ? { now: true } : {}),
	});
}

/** Mark that the next reconnect is a planned daemon replacement. */
export function markRestartPending() {
	try {
		sessionStorage.setItem(PENDING_KEY, "1");
	} catch {
		// private mode/storage full: the in-page restarting state still applies
	}
}

function takeRestartPending() {
	try {
		const value = sessionStorage.getItem(PENDING_KEY);
		if (value) sessionStorage.removeItem(PENDING_KEY);
		return Boolean(value);
	} catch {
		return false;
	}
}

/** A pause timeout with reload actions: wait another round or cancel. */
function handleReloadPauseTimeout(text) {
	const actions = pauseTimeoutActions("reload").map((action) => ({
		...action,
		onClick: () => {
			if (action.id === "wait") sendReload({ pause: true });
			else sendPauseCancel(action.id === "cancel-remove" ? "resume" : "keep");
		},
	}));
	appendPauseTimeoutCard(text, actions);
}

/**
 * A `notice` frame with `restart: true` or the opt-in `pause: true`. A refusal
 * paints the inline confirm card; a pause timeout paints the follow-up actions;
 * a success paints nothing here because the SIGUSR2 `restarting` frame follows.
 */
export function handleRestartNotice(frame) {
	if (frame.restart !== true && frame.pause !== true) return false;
	const text = typeof frame.text === "string" ? frame.text : "";
	const kind = frame.pauseKind === "reload" ? "reload" : "restart";
	const blockers = Array.isArray(frame.blockers) ? frame.blockers : [];
	if (frame.status === "pause-timeout") {
		if (kind === "reload") handleReloadPauseTimeout(text);
		else
			appendRestartCard(text, {
				pause: false,
				label: pauseTimeoutActions("restart")[0].label,
				targets: pauseTargetsText(blockers),
				onAction: () => sendRestart(true, { pause: true, now: true }),
			});
		return true;
	}
	if (frame.status === "refused") {
		if (blockers.length > 0) {
			appendRestartCard(text, {
				pause: true,
				label: pauseConfirmAction(kind),
				targets: pauseTargetsText(blockers),
				onAction: (pause) => (kind === "reload" ? sendReload({ pause }) : sendRestart(true, { pause })),
			});
		} else if (text) {
			appendReloadNotice(text);
		}
	}
	return true;
}

/** After reconnect, name the replacement and paint the one-shot pause report. */
export async function appendRestartResult(interrupted) {
	const pending = takeRestartPending();
	let text = pending ? "daemon restarted" : "pixip restarted";
	try {
		const response = await fetch("health", { cache: "no-store" });
		if (response.ok) {
			const health = await response.json();
			if (Number.isInteger(health.pid) && Number.isFinite(health.startedAt)) {
				text = `daemon restarted (pid ${health.pid}, uptime ${formatUptime(Date.now() - health.startedAt)})`;
			}
			const report = health.pauseResult;
			if (report) {
				const key = pauseResultKey(health.pid, report.at);
				if (claimPauseResult(sessionStorage, key)) {
					const row = pauseResultText(report);
					if (row) text += `; ${row}`;
				}
			}
		}
	} catch {
		// offline just after a restart: the generic row is still useful
	}
	if (interrupted) text += " — the previous turn was interrupted";
	appendReloadNotice(text);
}

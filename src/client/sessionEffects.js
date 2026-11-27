// Session frame effects: the explicit handlers the protocol adapter calls for
// snapshots, restarts, status, re-keys and socket close. Decisions come from
// the pure sessionPlan.js helpers; this module applies them.
import { clearCompaction } from "./compaction.js";
import { installDeps } from "./configure.js";
import { applyInfo } from "./sessionView.js";
import { closePlan, openedPlan, snapshotPlan, statusPlan } from "./sessionPlan.js";
import { toast } from "./toast.js";
import { restoreReloadNotice } from "./reload.js";
import { connect, rekeyConnection, send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureSessionEffects(next) {
	deps = installDeps("sessionEffects", "configureSessionEffects", next, [
		"clearPendingAttachment",
		"failPendingSession",
		"openSession",
		"appendRestartNotice",
		"lastEntryId",
		"renderResume",
		"renderSnapshot",
		"renderTranscript",
	]);
}

/** Replacement snapshot: a compaction or a `/new` invalidates loaded windows. */
export function renderReplace(entries, more) {
	// The old DOM (and any live streaming node) is about to be replaced. Drop the
	// references so the next delta starts a fresh block instead of writing into a
	// detached section.
	state.streaming = null;
	state.pendingUser = null;
	state.pending = "";
	state.entries = [];
	state.more = false;
	state.stick = true;
	deps.renderSnapshot(entries, more);
}

export function handleSnapshot(frame) {
	const plan = snapshotPlan(frame, state);
	if (plan.resetLive) {
		state.restarting = false;
		state.restartWasBusy = false;
		state.restartNoticePending = true;
		// The old child was aborted: drop the live/optimistic DOM references,
		// then repaint from entries so a half-rendered turn or a prompt that
		// never reached Pi cannot survive as a ghost block.
		state.streaming = null;
		state.liveThought = null;
		state.pendingUser = null;
	}
	state.info = frame.session;
	const entries = frame.entries ?? [];
	if (plan.render === "replace") {
		// A just-finished compaction carries its post-summary estimate only in the
		// event; pin it to the newest boundary before the snapshot paints.
		const boundary = [...entries].reverse().find((entry) => entry?.type === "compaction");
		if (typeof boundary?.id === "string" && state.compactionResult) {
			state.compactionMeta = { id: boundary.id, ...state.compactionResult };
		}
		state.compactionResult = null;
		if (!boundary) state.compactionMeta = null;
	}
	if (plan.render === "resume") deps.renderResume(entries);
	else if (plan.render === "replace") renderReplace(entries, frame.more === true);
	else deps.renderSnapshot(entries, frame.more === true);
	if (plan.repaint) deps.renderTranscript();
	applyInfo();
	restoreReloadNotice();
	if (state.restartNoticePending) {
		state.restartNoticePending = false;
		void deps.appendRestartNotice(plan.interrupted);
	}
}

export function handleRestarting() {
	state.restarting = true;
	state.restartWasBusy = Boolean(state.streaming || state.info?.state === "busy" || state.pendingUser);
	applyInfo();
	toast("pixip restarting…");
}

export function handleStatus(frame) {
	const plan = statusPlan(frame, state);
	if (plan.act !== "apply") return;
	state.info = frame.session;
	if (state.info?.state === "stopped" || state.info?.state === "error") clearCompaction();
	applyInfo();
	if (plan.quit) {
		state.quitting = false;
		location.hash = "";
	}
}

export function handleOpened(frame) {
	const plan = openedPlan(frame, {
		pendingCreate: Boolean(state.pendingCreate),
		sessionId: state.sessionId,
		connected: Boolean(state.ws),
	});
	if (plan.act === "ignore") return;
	if (plan.act === "open") {
		// The pending view already owns the screen; swap the URL and connect.
		state.pendingCreate = null;
		state.sessionId = null;
		history.replaceState(null, "", `#s=${encodeURIComponent(plan.id)}`);
		deps.openSession(plan.id);
		return;
	}
	if (plan.act === "reattach") {
		// An index-only session reattached under a new Pi id: keep this socket
		// and transcript, and move the URL to the new id without reconnecting.
		if (plan.changed) state.sessionCache.delete(plan.previousId);
		if (plan.changed) rekeyConnection(plan.previousId, plan.id);
		state.sessionId = plan.id;
		if (frame.session) state.info = frame.session;
		history.replaceState(null, "", `#s=${encodeURIComponent(plan.id)}`);
		if (plan.rekey) {
			// `/new` in the same child: the old transcript belongs to a different
			// session, so ask for a replacement window.
			state.sessionCache.delete(plan.id);
			state.entries = [];
			state.more = false;
			state.tools.clear();
			state.streaming = null;
			state.liveThought = null;
			state.pendingUser = null;
			deps.clearPendingAttachment();
			state.bashRunning = false;
			state.bash.clear();
			ui.log.textContent = "";
			send({ t: "resnapshot" });
		}
		applyInfo();
		return;
	}
	location.hash = `s=${encodeURIComponent(plan.id)}`;
}

/** Socket close: reconnect with the durable cursor, or fail a pending create. */
export function handleTransportClose() {
	clearCompaction();
	const plan = closePlan({
		pendingCreate: Boolean(state.pendingCreate),
		sessionId: state.sessionId,
		retries: state.retries,
	});
	if (plan.act === "fail") {
		deps.failPendingSession("daemon disconnected");
		return;
	}
	if (plan.act === "none") return;
	state.retries += 1;
	toast(state.restarting ? `pixip restarting — reconnecting… (${plan.delay}ms)` : `reconnecting… (${plan.delay}ms)`);
	setTimeout(() => connect(state.sessionId, deps.lastEntryId()), plan.delay);
}

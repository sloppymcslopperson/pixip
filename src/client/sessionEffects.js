// Session frame effects: the explicit handlers the protocol adapter calls for
// snapshots, restarts, status, re-keys and socket close. Decisions come from
// the pure sessionPlan.js helpers; this module applies them.
import { clearPendingAttachment } from "./composerAttachments.js";
import { applyInfo } from "./controls.js";
import { closePlan, openedPlan, snapshotPlan, statusPlan } from "./sessionPlan.js";
import { failPendingSession, openSession } from "./session.js";
import { appendRestartNotice, lastEntryId, renderResume, renderSnapshot, renderTranscript } from "./transcript.js";
import { toast } from "./toast.js";
import { connect, send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

/** Replacement snapshot: a compaction or a `/new` invalidates loaded windows. */
export function renderReplace(entries, more) {
	state.entries = [];
	state.more = false;
	state.stick = true;
	renderSnapshot(entries, more);
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
		state.pendingUser = null;
	}
	state.info = frame.session;
	if (plan.render === "resume") renderResume(frame.entries ?? []);
	else if (plan.render === "replace") renderReplace(frame.entries ?? [], frame.more === true);
	else renderSnapshot(frame.entries ?? [], frame.more === true);
	if (plan.repaint) renderTranscript();
	applyInfo();
	if (state.restartNoticePending) {
		state.restartNoticePending = false;
		appendRestartNotice(plan.interrupted);
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
		openSession(plan.id);
		return;
	}
	if (plan.act === "reattach") {
		// An index-only session reattached under a new Pi id: keep this socket
		// and transcript, and move the URL to the new id without reconnecting.
		if (plan.changed) state.sessionCache.delete(plan.previousId);
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
			state.pendingUser = null;
			clearPendingAttachment();
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
	const plan = closePlan({
		pendingCreate: Boolean(state.pendingCreate),
		sessionId: state.sessionId,
		retries: state.retries,
	});
	if (plan.act === "fail") {
		failPendingSession("daemon disconnected");
		return;
	}
	if (plan.act === "none") return;
	state.retries += 1;
	toast(state.restarting ? `pixip restarting — reconnecting… (${plan.delay}ms)` : `reconnecting… (${plan.delay}ms)`);
	setTimeout(() => connect(state.sessionId, lastEntryId()), plan.delay);
}

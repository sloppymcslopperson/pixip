// Protocol adapter: one switch maps hub frames to feature handlers. Features
// never import this module; the composition root installs it as the transport's
// frame/close handler.
import { copyText } from "./clipboard.js";
import { applyPolicy } from "./composer.js";
import { finishBash } from "./composerBash.js";
import { handleOpened, handleRestarting, handleSnapshot, handleStatus } from "./sessionEffects.js";
import { failPendingSession } from "./session.js";
import { renderFooter } from "./sessionView.js";
import { closeSession, connectionState } from "./transport.js";
import { listSessions } from "./dashboardApi.js";
import { decorateUserRefs } from "./reftagActions.js";
import { renderList } from "./dashboardList.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";
import { renderMenu, restoreClearedQueue } from "./menu.js";
import { applyInboxFrame } from "./inbox.js";
import { handleNotice } from "./reload.js";
import { handleRestartNotice, markRestartPending } from "./restart.js";
import { handleWatchNotice } from "./watch.js";
import { openExportSheet, openModelSheet, openThinkingSheet, openTreeSheet } from "./sheets.js";
import { dropSurface, handleNeedTime, handleReasks } from "./surface.js";
import {
	applyFullEntry,
	applyLiveThinking,
	decorateAgentSenders,
	handleEvent,
	prependHistory,
	renderTranscript,
} from "./transcript.js";
import { toast } from "./toast.js";

let sessionsLoading = false;

/**
 * A deep-linked session paints before any list frame. Fetch the existing
 * dashboard list once so sender names and links can arrive without a repaint.
 */
function ensureSessions() {
	if ((Array.isArray(state.sessions) && state.sessions.length > 0) || sessionsLoading) return;
	sessionsLoading = true;
	void listSessions()
		.then((sessions) => {
			if (!Array.isArray(sessions) || sessions.length === 0) return;
			state.sessions = sessions;
			decorateAgentSenders();
			void decorateUserRefs();
		})
		.finally(() => {
			sessionsLoading = false;
		});
}

/** A parked session that stopped, errored or vanished no longer owns a socket. */
function evictStoppedParked(sessions) {
	const list = Array.isArray(sessions) ? sessions : [];
	for (const id of connectionState().parked) {
		if (!id) continue;
		const match = list.find((session) => session.id === id || session.logicalId === id);
		if (!match || match.state === "stopped" || match.state === "error") closeSession(id);
	}
}

/** Frames from a parked/background session update its cache, never this route. */
function handleBackgroundFrame(sessionId, frame) {
	if (frame.t === "opened" && frame.rekey === true) {
		// `/new` moved this Pi id: the warm socket is stale, so drop it and let
		// activation reconnect through the normal path.
		closeSession(sessionId);
		state.sessionCache.delete(sessionId);
		return;
	}
	const cached = state.sessionCache.get(sessionId);
	if (!cached) return;
	switch (frame.t) {
		case "status":
			if (frame.session) cached.info = frame.session;
			break;
		case "footer":
			cached.footer = frame.footer;
			break;
		case "policy":
			cached.policy = frame.policy;
			break;
		case "commands":
			cached.commands = Array.isArray(frame.commands) ? [...frame.commands] : [];
			break;
		case "notice":
			// A parked tab still reloads for the new assets/nonce, but the row belongs
			// to the session that is actually on screen.
			handleNotice(frame, { row: false });
			break;
		case "queue":
			cached.queue = {
				steering: Array.isArray(frame.steering) ? [...frame.steering] : [],
				followUp: Array.isArray(frame.followUp) ? [...frame.followUp] : [],
			};
			break;
		default:
			break;
	}
}

export function handleFrame(fromSessionId, frame) {
	// The dashboard socket (null) is global; a session socket that is not the
	// current route is a parked background socket.
	if (fromSessionId && fromSessionId !== state.sessionId) {
		handleBackgroundFrame(fromSessionId, frame);
		return;
	}
	switch (frame.t) {
		case "inbox":
			applyInboxFrame(frame.inbox);
			break;
		case "hello":
			if (Array.isArray(frame.sessions)) {
				state.sessions = frame.sessions;
				// A deep link has no dashboard `sessions` frame; hello already
				// carries the list, so cross-session refs can resolve here.
				decorateAgentSenders();
				void decorateUserRefs();
			}
			if (!state.sessionId) {
				if (typeof frame.defaultCwd === "string") state.defaultCwd = frame.defaultCwd;
				if (typeof frame.home === "string") state.home = frame.home;
				void listSessions().then((sessions) => renderList(sessions, state.defaultCwd, state.home));
			}
			break;
		case "sessions": {
			const sessions = Array.isArray(frame.sessions) ? frame.sessions : [];
			state.sessions = sessions;
			// A deep link paints the transcript before this frame; refs to other
			// sessions only resolve once their names and locations are here.
			decorateAgentSenders();
			void decorateUserRefs();
			evictStoppedParked(sessions);
			if (!state.sessionId) {
				renderList(sessions, state.defaultCwd, state.home);
				break;
			}
			const logical = state.info?.logicalId;
			const present = sessions.some(
				(session) => session.id === state.sessionId || (logical && session.logicalId === logical),
			);
			if (!present) {
				state.sessionCache.delete(state.sessionId);
				state.sessionId = null;
				toast("session is no longer available");
				location.hash = "";
			}
			break;
		}
		case "snapshot":
			handleSnapshot(frame);
			ensureSessions();
			break;
		case "live_thinking":
			applyLiveThinking(frame);
			break;
		case "restarting":
			markRestartPending();
			handleRestarting();
			break;
		case "notice":
			if (!handleRestartNotice(frame) && !handleWatchNotice(frame)) handleNotice(frame);
			break;
		case "history":
			prependHistory(frame.entries ?? [], frame.more === true);
			break;
		case "entry":
			applyFullEntry(frame);
			break;
		case "ui_need_time":
			handleNeedTime(frame);
			toast("Question needs more time — keep it or shelve it");
			break;
		case "ui_timeout":
			dropSurface(`reask:${String(frame.id ?? "")}`);
			dropSurface(String(frame.id ?? ""));
			toast("Question timed out — re-ask it if you still need it");
			break;
		case "reasks":
			handleReasks(frame.requests ?? []);
			break;
		case "status":
			handleStatus(frame);
			break;
		case "opened":
			handleOpened(frame);
			break;
		case "copy":
			void copyText(frame.text);
			break;
		case "event":
			handleEvent(frame.ev);
			break;
		case "footer":
			state.footer = frame.footer;
			renderFooter();
			break;
		case "policy":
			applyPolicy(frame.policy);
			break;
		case "commands":
			state.dynamicCommands = Array.isArray(frame.commands) ? frame.commands : [];
			if (!ui.menu.hidden) renderMenu();
			break;
		case "queue":
			restoreClearedQueue(frame);
			break;
		case "tree":
			openTreeSheet(
				Array.isArray(frame.tree) ? frame.tree : [],
				typeof frame.leafId === "string" ? frame.leafId : null,
			);
			break;
		case "fork":
			if (frame.cancelled) toast("fork cancelled");
			else toast(frame.text ? `forked: ${String(frame.text).slice(0, 80)}` : "forked");
			break;
		case "clone":
			toast(frame.cancelled ? "clone cancelled" : "cloned");
			break;
		case "import":
			toast(frame.cancelled ? "import cancelled" : "imported");
			break;
		case "export":
			openExportSheet(String(frame.html ?? ""), typeof frame.jsonl === "string" ? frame.jsonl : null);
			break;
		case "bash":
			finishBash(frame);
			break;
		case "models":
			state.models = frame.models ?? [];
			openModelSheet(frame.current);
			break;
		case "thinking":
			state.levels = frame.levels ?? [];
			openThinkingSheet(frame.current);
			break;
		case "error":
			if (state.pendingCreate) {
				failPendingSession(frame.message);
				break;
			}
			if (state.loadingEarlier) {
				const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
				state.loadingEarlier = false;
				renderTranscript(distance);
			}
			toast(frame.message);
			break;
		default:
			break;
	}
}

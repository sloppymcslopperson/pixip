// Protocol adapter: one switch maps hub frames to feature handlers. Features
// never import this module; the composition root installs it as the transport's
// frame/close handler.
import { copyText } from "./clipboard.js";
import { applyPolicy, clearPendingAttachment, finishBash, renderReplace } from "./composer.js";
import { applyInfo, renderFooter } from "./controls.js";
import { listSessions } from "./dashboardApi.js";
import { renderList } from "./dashboardList.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";
import { renderMenu, restoreClearedQueue } from "./menu.js";
import { failPendingSession, openSession } from "./session.js";
import { openExportSheet, openModelSheet, openThinkingSheet, openTreeSheet } from "./sheets.js";
import {
	appendRestartNotice,
	handleEvent,
	lastEntryId,
	prependHistory,
	renderResume,
	renderSnapshot,
	renderTranscript,
} from "./transcript.js";
import { toast } from "./toast.js";
import { connect, send } from "./transport.js";

export function handleFrame(frame) {
	switch (frame.t) {
		case "hello":
			if (!state.sessionId) {
				if (typeof frame.defaultCwd === "string") state.defaultCwd = frame.defaultCwd;
				if (typeof frame.home === "string") state.home = frame.home;
				void listSessions().then((sessions) => renderList(sessions, state.defaultCwd, state.home));
			}
			break;
		case "sessions": {
			const sessions = Array.isArray(frame.sessions) ? frame.sessions : [];
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
		case "snapshot": {
			const wasRestarting = state.restarting;
			const interrupted = wasRestarting && state.restartWasBusy;
			if (wasRestarting) {
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
			if (frame.resume === true) renderResume(frame.entries ?? []);
			else if (frame.replace === true) renderReplace(frame.entries ?? [], frame.more === true);
			else renderSnapshot(frame.entries ?? [], frame.more === true);
			if (wasRestarting) renderTranscript();
			applyInfo();
			if (state.restartNoticePending) {
				state.restartNoticePending = false;
				appendRestartNotice(interrupted);
			}
			break;
		}
		case "restarting":
			state.restarting = true;
			state.restartWasBusy = Boolean(state.streaming || state.info?.state === "busy" || state.pendingUser);
			applyInfo();
			toast("pixip restarting…");
			break;
		case "history":
			prependHistory(frame.entries ?? [], frame.more === true);
			break;
		case "status":
			if (frame.session?.id === state.sessionId || !state.sessionId) {
				state.info = frame.session;
				applyInfo();
				if (state.quitting && frame.session.state === "stopped") {
					state.quitting = false;
					location.hash = "";
				}
			}
			break;
		case "opened": {
			const id = frame.session?.id;
			if (typeof id !== "string") break;
			if (state.pendingCreate) {
				// The pending view already owns the screen; swap the URL and connect.
				state.pendingCreate = null;
				state.sessionId = null;
				history.replaceState(null, "", `#s=${encodeURIComponent(id)}`);
				openSession(id);
				break;
			}
			if (state.sessionId && state.ws) {
				// An index-only session reattached under a new Pi id: keep this socket
				// and transcript, and move the URL to the new id without reconnecting.
				const previousId = state.sessionId;
				const changed = previousId !== id;
				if (changed) state.sessionCache.delete(previousId);
				state.sessionId = id;
				if (frame.session) state.info = frame.session;
				history.replaceState(null, "", `#s=${encodeURIComponent(id)}`);
				if (frame.rekey === true && changed) {
					// `/new` in the same child: the old transcript belongs to a
					// different session, so ask for a replacement window.
					state.sessionCache.delete(id);
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
			} else {
				location.hash = `s=${encodeURIComponent(id)}`;
			}
			break;
		}
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

/** Socket close: reconnect with the durable cursor, or fail a pending create. */
export function handleTransportClose() {
	if (state.pendingCreate) {
		failPendingSession("daemon disconnected");
		return;
	}
	if (!state.sessionId) return;
	const delay = Math.min(2000, 200 * 2 ** state.retries++);
	toast(state.restarting ? `pixip restarting — reconnecting… (${delay}ms)` : `reconnecting… (${delay}ms)`);
	setTimeout(() => connect(state.sessionId, lastEntryId()), delay);
}

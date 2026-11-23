// Protocol adapter: one switch maps hub frames to feature handlers. Features
// never import this module; the composition root installs it as the transport's
// frame/close handler.
import { copyText } from "./clipboard.js";
import { applyPolicy } from "./composer.js";
import { finishBash } from "./composerBash.js";
import { handleOpened, handleRestarting, handleSnapshot, handleStatus } from "./sessionEffects.js";
import { failPendingSession } from "./session.js";
import { renderFooter } from "./controls.js";
import { listSessions } from "./dashboardApi.js";
import { renderList } from "./dashboardList.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";
import { renderMenu, restoreClearedQueue } from "./menu.js";
import { openExportSheet, openModelSheet, openThinkingSheet, openTreeSheet } from "./sheets.js";
import { dropSurface, handleNeedTime, handleReasks } from "./surface.js";
import { handleEvent, prependHistory, renderTranscript } from "./transcript.js";
import { toast } from "./toast.js";

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
		case "snapshot":
			handleSnapshot(frame);
			break;
		case "restarting":
			handleRestarting();
			break;
		case "history":
			prependHistory(frame.entries ?? [], frame.more === true);
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

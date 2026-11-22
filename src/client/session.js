// Client session module; shared state and transport live in app.js.
import {
	appendRestartNotice,
	applyPolicy,
	clearPendingAttachment,
	closeMenu,
	connect,
	copyText,
	createAddonUi,
	escapeHtml,
	finishBash,
	handleEvent,
	hideThinkingIndicator,
	listSessions,
	openExportSheet,
	openModelSheet,
	openThinkingSheet,
	openTreeSheet,
	pendingErrorHtml,
	pendingSessionHtml,
	prependHistory,
	refreshSendState,
	renderFooter,
	renderList,
	renderMenu,
	renderQueue,
	renderReplace,
	renderResume,
	renderSnapshot,
	renderTranscript,
	resize,
	resetSurface,
	restoreClearedQueue,
	scrollToEnd,
	send,
	state,
	toast,
	ui,
	updateJump,
} from "./app.js";

export function beginNewSession(cwd) {
	state.pendingCreate = { cwd };
	history.pushState(null, "", "#new");
	showPendingSession();
	// The dashboard socket is still open; the `opened` frame will carry the id.
	send({ t: "create", cwd });
}

export function showPendingSession() {
	state.sessionId = null;
	ui.jump.hidden = true;
	state.info = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	clearPendingAttachment();
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
	resetSurface();
	state.policy = null;
	state.dynamicCommands = [];
	state.queue = { steering: [], followUp: [] };
	renderQueue();
	closeMenu();
	state.bashRunning = false;
	state.quitting = false;
	state.bash.clear();
	ui.list.hidden = true;
	ui.session.hidden = false;
	ui.composer.hidden = false;
	ui.footer.hidden = true;
	ui.dock.hidden = false;
	ui.stop.hidden = true;
	ui.back.hidden = false;
	ui.settings.hidden = true;
	ui.log.innerHTML = pendingSessionHtml();
	ui.title.textContent = "new session";
	ui.sub.textContent = "starting…";
	ui.dot.hidden = false;
	ui.dot.className = "dot busy";
	ui.input.value = "";
	ui.input.disabled = true;
	ui.attach.disabled = true;
	ui.send.disabled = true;
	document.title = "new session · pixip";
}

export function failPendingSession(message) {
	state.pendingCreate = null;
	ui.log.innerHTML = pendingErrorHtml(String(message));
	const back = document.createElement("button");
	back.type = "button";
	back.className = "row";
	back.textContent = "back to sessions";
	back.addEventListener("click", () => {
		location.hash = "";
	});
	ui.log.append(back);
	ui.title.textContent = "new session";
	ui.sub.textContent = "failed";
	ui.dot.className = "dot error";
	ui.input.disabled = true;
	ui.attach.disabled = true;
	ui.send.disabled = true;
	document.title = "new session · pixip";
}

export function openSession(id) {
	if (state.sessionId === id) return;
	cacheCurrentSession();
	state.pendingCreate = null;
	state.sessionId = id;
	state.restarting = false;
	state.restartWasBusy = false;
	state.restartNoticePending = false;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	clearPendingAttachment();
	state.policy = null;
	state.dynamicCommands = [];
	state.queue = { steering: [], followUp: [] };
	renderQueue();
	closeMenu();
	state.bashRunning = false;
	state.quitting = false;
	state.bash.clear();
	ui.list.hidden = true;
	ui.session.hidden = false;
	ui.composer.hidden = false;
	ui.footer.hidden = false;
	ui.dock.hidden = false;
	ui.stop.hidden = false;
	ui.back.hidden = false;
	ui.settings.hidden = true;
	ui.log.textContent = "";
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
	resetSurface();
	state.stick = true;
	updateJump();
	ui.title.textContent = "connecting…";
	ui.sub.textContent = id.slice(0, 8);
	ui.dot.className = "dot busy";
	document.title = "pixip";
	const cached = state.sessionCache.get(id);
	if (cached) restoreCachedSession(cached);
	else ui.input.value = "";
	connect(id);
}

export function cacheCurrentSession() {
	const id = state.sessionId;
	if (!id) return;
	state.sessionCache.set(id, {
		entries: state.entries,
		more: state.more,
		distance: state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop,
		stick: state.stick,
		info: state.info,
		footer: state.footer,
		addon: state.addon,
		queue: { steering: [...state.queue.steering], followUp: [...state.queue.followUp] },
		input: ui.input.value,
	});
}

export function restoreCachedSession(cached) {
	state.entries = Array.isArray(cached.entries) ? cached.entries : [];
	state.more = Boolean(cached.more);
	state.stick = cached.stick !== false;
	state.info = cached.info ?? null;
	state.footer = cached.footer ?? null;
	state.addon = cached.addon ?? createAddonUi();
	state.queue = cached.queue
		? { steering: [...cached.queue.steering], followUp: [...cached.queue.followUp] }
		: { steering: [], followUp: [] };
	ui.input.value = cached.input ?? "";
	renderTranscript(cached.distance ?? (state.stick ? ui.log.clientHeight : null));
	renderQueue();
	renderFooter();
	if (state.info) applyInfo();
	resize();
}

export function forgetCachedSession(session) {
	if (!session) return;
	state.sessionCache.delete(session.id);
	if (typeof session.logicalId === "string") state.sessionCache.delete(session.logicalId);
}

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

export function applyInfo() {
	const info = state.info;
	if (!info) return;
	const restarting = state.restarting;
	const name = info.name ?? info.id.slice(0, 8);
	ui.title.textContent = name;
	document.title = `${name} · pixip`;
	// Separators live inside the `.wide` wrapper so hiding it on narrow screens
	// does not leave dangling "· ·" separators behind.
	let subtitle = escapeHtml(restarting ? "restarting…" : info.state);
	const wide = [info.model, info.thinkingLevel].filter(Boolean).map((part) => escapeHtml(part));
	if (wide.length > 0) subtitle += ` · <span class="wide">${wide.join(" · ")}</span>`;
	if (info.messageCount) subtitle += ` · ${info.messageCount} msg`;
	ui.sub.innerHTML = subtitle;
	ui.sub.title = [restarting ? "restarting" : info.state, info.model, info.thinkingLevel].filter(Boolean).join(" · ");
	ui.dot.hidden = false;
	ui.dot.className = `dot ${restarting ? "busy" : info.state}`;
	const stopped = !restarting && (info.state === "stopped" || info.state === "error");
	const starting = !restarting && info.state === "starting";
	if (stopped || starting) hideThinkingIndicator();
	ui.input.disabled = restarting || stopped || starting;
	ui.attach.disabled = restarting || stopped || starting;
	refreshSendState();
	// The provisional transcript is already readable; this only says the child
	// is still booting and live events have not started yet.
	let startingHint = ui.log.querySelector(".starting");
	if (starting && !startingHint) {
		startingHint = document.createElement("div");
		startingHint.className = "block meta starting";
		startingHint.textContent = "starting pi…";
		ui.log.append(startingHint);
		scrollToEnd();
	} else if (!starting) {
		startingHint?.remove();
	}
	if (stopped && !ui.log.querySelector(".wake")) {
		const wake = document.createElement("button");
		wake.className = "row wake";
		wake.textContent = info.state === "error" ? "restart session" : "wake session";
		wake.addEventListener("click", () => connect(state.sessionId));
		ui.log.append(wake);
		scrollToEnd();
	} else if (!stopped) {
		ui.log.querySelector(".wake")?.remove();
	}
}

// Client session module; shared state lives in kernel/state.js.
import { createAddonUi } from "./addonUi.js";
import { clearPendingAttachment } from "./composer.js";
import { applyInfo, closeMenu, renderFooter, renderQueue, resize, updateJump } from "./controls.js";
import { pendingErrorHtml, pendingSessionHtml } from "./render.js";
import { resetSurface } from "./surface.js";
import { renderTranscript } from "./transcript.js";
import { connect, send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

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

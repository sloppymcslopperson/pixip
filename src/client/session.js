// Client session module; shared state lives in kernel/state.js.
import { createAddonUi } from "./addonUi.js";
import { installDeps } from "./configure.js";
import { resize } from "./composerInput.js";
import { clearCompaction } from "./compaction.js";
import { closeMenu } from "./menuView.js";
import { renderQueue } from "./queueView.js";
import { pendingErrorHtml, pendingSessionHtml } from "./render.js";
import { updateJump } from "./scroll.js";
import { applyInfo, renderFooter, resetPeerNotice } from "./sessionView.js";
import { readingDistance, restoreSession, snapshotSession } from "./sessionCache.js";
import { restoreSurface, surfaceStatus } from "./surface.js";
import { closeSession, connect, park, resume, send } from "./transport.js";
import { lastEntryId } from "./transcriptWindow.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureSession(next) {
	deps = installDeps("session", "configureSession", next, [
		"clearPendingAttachment",
		"resetSurface",
		"renderTranscript",
	]);
}

export function beginNewSession(cwd, worktree) {
	cacheCurrentSession();
	parkCurrentSession();
	// The dashboard socket is session-less and always kept separate; the
	// `opened` frame will carry the new id.
	connect(null);
	state.pendingCreate = worktree ? { cwd, worktree } : { cwd };
	history.pushState(null, "", "#new");
	showPendingSession();
	send(worktree ? { t: "create", cwd, worktree } : { t: "create", cwd });
}

export function showPendingSession() {
	clearCompaction();
	state.sessionId = null;
	ui.jump.hidden = true;
	state.info = null;
	state.tools.clear();
	state.streaming = null;
	state.liveThought = null;
	state.pendingUser = null;
	deps.clearPendingAttachment();
	resetPeerNotice();
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
	deps.resetSurface();
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
	clearCompaction();
	cacheCurrentSession();
	parkCurrentSession();
	state.pendingCreate = null;
	state.sessionId = id;
	state.restarting = false;
	state.restartWasBusy = false;
	state.restartNoticePending = false;
	state.tools.clear();
	state.streaming = null;
	state.liveThought = null;
	state.pendingUser = null;
	deps.clearPendingAttachment();
	resetPeerNotice();
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
	deps.resetSurface();
	state.stick = true;
	updateJump();
	ui.title.textContent = "connecting…";
	ui.sub.textContent = id.slice(0, 8);
	ui.dot.className = "dot busy";
	document.title = "pixip";
	const cached = state.sessionCache.get(id);
	let cursor = null;
	if (cached) {
		restoreCachedSession(cached);
		// The page already holds this transcript: resume from its last entry
		// instead of paying for the full window again.
		cursor = cached.lastEntryId ?? lastEntryId(state.entries);
	} else ui.input.value = "";
	// A warm parked socket needs only `resume`; anything else reconnects (or
	// attaches a stopped/cold session) through the normal path.
	if (!resume(id, cursor)) connect(id, cursor);
}

/** Cache the active view and park or close its socket before leaving the route. */
export function parkCurrentSession() {
	const id = state.sessionId;
	if (!id) return;
	const kind = state.info?.state;
	if ((kind === "idle" || kind === "busy") && park(id)) return;
	closeSession(id);
}

export function cacheCurrentSession() {
	const id = state.sessionId;
	if (!id) return;
	state.sessionCache.set(
		id,
		snapshotSession({
			entries: state.entries,
			more: state.more,
			distance: readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop),
			stick: state.stick,
			info: state.info,
			footer: state.footer,
			policy: state.policy,
			commands: state.dynamicCommands,
			addon: state.addon,
			queue: state.queue,
			input: ui.input.value,
			lastEntryId: lastEntryId(state.entries),
			surface: surfaceStatus(),
		}),
	);
}

export function restoreCachedSession(cached) {
	const restored = restoreSession(cached);
	state.entries = restored.entries;
	state.more = restored.more;
	state.stick = restored.stick;
	state.info = restored.info;
	state.footer = restored.footer;
	state.policy = restored.policy;
	state.dynamicCommands = restored.commands;
	state.addon = restored.addon ?? createAddonUi();
	state.queue = restored.queue;
	ui.input.value = restored.input;
	deps.renderTranscript(restored.distance ?? (state.stick ? ui.log.clientHeight : null));
	renderQueue();
	renderFooter();
	restoreSurface(restored.surface);
	if (state.info) applyInfo();
	resize();
}

export function forgetCachedSession(session) {
	if (!session) return;
	closeSession(session.id);
	state.sessionCache.delete(session.id);
	if (typeof session.logicalId === "string") state.sessionCache.delete(session.logicalId);
}

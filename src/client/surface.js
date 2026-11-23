// Inline blocking-request surface. It is not a modal: #log remains the only
// transcript scroll container, and the surface docks between the transcript and
// the composer. App-owned sheets stay in sheets.js.
import { registerA2uiPanel } from "./a2ui.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";
import { createSurfaceQueue, enqueueSurface, nextComposerState, settleSurface } from "./surfaceQueue.js";
import {
	closeAllPanels,
	closePanel,
	openPanel,
	panelDraft,
	panelTitle,
	savePanelDraft,
	setPanelDraft,
} from "./panelHost.js";

// Claim the "a2ui" mode at startup without loading the bundle: the lazy
// adapter imports it when the first A2UI panel arrives.
registerA2uiPanel();

const queue = createSurfaceQueue();
let collapsed = false;
let renderedId = null;
let lastShell = null;
let observer = null;
let composerBeforeSurface = null;
let pendingReaskDraft;

let lastSurfaceHeight = 0;

/** Hide the composer while any blocking request is up; restore what was there. */
function syncComposer() {
	if (!ui.composer) return;
	const next = nextComposerState(queue.active, ui.composer.hidden, composerBeforeSurface);
	ui.composer.hidden = next.hidden;
	composerBeforeSurface = next.saved;
}

/** Keep the jump pill above the surface instead of overlaying its actions. */
function syncOffset() {
	const root = ui.surface;
	if (!root) return;
	const height = root.hidden ? 0 : root.offsetHeight;
	const grew = height > lastSurfaceHeight;
	lastSurfaceHeight = height;
	root.parentElement?.style.setProperty("--surface-height", `${height}px`);
	// Growing the panel shrinks #log. If the transcript was pinned to the
	// newest entry, re-pin it so the panel does not appear to scroll the log.
	if (grew && state.stick && ui.log) ui.log.scrollTop = ui.log.scrollHeight;
}

function observeSurface() {
	if (observer || typeof ResizeObserver !== "function" || !ui.surface) return;
	observer = new ResizeObserver(() => syncOffset());
	observer.observe(ui.surface);
}

const BLOCKING = ["select", "confirm", "input", "editor", "panel", "reask", "more_time"];
const panelTitles = new Map();

function titleOf(request) {
	if (request?.method === "panel") {
		return panelTitles.get(request.id) ?? panelTitle(request.payload);
	}
	if (request?.method === "reask") {
		const original = request.reask?.request ?? {};
		const label = original.title ?? original.message ?? original.payload?.title ?? request.reask?.method ?? "request";
		return `Re-ask: ${String(label).trim()}`;
	}
	if (request?.method === "more_time") return "Need more time?";
	const title = request?.title ?? request?.message;
	if (typeof title === "string" && title.trim()) return title.trim();
	if (request?.method === "select") return "Choose an option";
	if (request?.method === "confirm") return "Confirm";
	if (request?.method === "input") return "Input";
	if (request?.method === "editor") return "Edit";
	return "Extension request";
}

function logPosition() {
	if (!ui.log) return { stick: true, distance: 0 };
	return {
		stick: state.stick,
		distance: state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop,
	};
}

function restoreLog(position) {
	if (!ui.log) return;
	if (position.stick) ui.log.scrollTop = ui.log.scrollHeight;
	else ui.log.scrollTop = Math.max(0, ui.log.scrollHeight - position.distance);
}

function shell() {
	if (lastShell) return lastShell;
	const root = ui.surface;
	root.textContent = "";
	const head = document.createElement("div");
	head.className = "surface-head";

	const titles = document.createElement("div");
	titles.className = "surface-titles";
	const title = document.createElement("div");
	title.className = "surface-title";
	const status = document.createElement("div");
	status.className = "surface-status";
	titles.append(title, status);

	const collapse = document.createElement("button");
	collapse.type = "button";
	collapse.className = "surface-collapse";
	collapse.addEventListener("click", () => {
		collapsed = !collapsed;
		renderSurface();
	});

	const close = document.createElement("button");
	close.type = "button";
	close.className = "surface-close";
	close.setAttribute("aria-label", "cancel extension request");
	close.textContent = "×";
	close.addEventListener("click", () => cancelSurface());

	head.append(titles, collapse, close);

	const banner = document.createElement("div");
	banner.className = "surface-banner";
	banner.hidden = true;
	const bannerText = document.createElement("span");
	bannerText.className = "surface-banner-text";
	const replace = document.createElement("button");
	replace.type = "button";
	replace.className = "surface-replace";
	replace.textContent = "Replace";
	replace.addEventListener("click", () => cancelSurface());
	banner.append(bannerText, replace);

	const body = document.createElement("div");
	body.className = "surface-body";

	root.append(head, banner, body);
	lastShell = { root, title, status, collapse, close, banner, bannerText, replace, body };
	return lastShell;
}

function actionRow() {
	const actions = document.createElement("div");
	actions.className = "surface-actions";
	return actions;
}

function addButton(actions, label, fields, className = "") {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	if (className) button.classList.add(className);
	button.addEventListener("click", () => finishSurface(fields));
	actions.append(button);
}

function formatAge(ms) {
	const hours = Math.round(ms / 3_600_000);
	if (hours >= 1) return `${hours}h`;
	return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function mountReask(request) {
	const { body } = shell();
	body.textContent = "";
	const record = request.reask ?? {};
	const original = record.request ?? {};
	const note = document.createElement("div");
	note.className = "surface-hint";
	const label = original.title ?? original.message ?? original.payload?.title ?? record.method ?? "request";
	note.textContent = `${String(label)} timed out after ${formatAge(Number(record.timeoutMs) || 0)} with no answer. Ask the agent to show it again?`;
	body.append(note);
	const actions = actionRow();
	const ask = document.createElement("button");
	ask.type = "button";
	ask.className = "primary";
	ask.textContent = "re-ask";
	ask.addEventListener("click", () => finishReask("ask"));
	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.textContent = "dismiss";
	dismiss.addEventListener("click", () => finishReask("dismiss"));
	actions.append(ask, dismiss);
	body.append(actions);
}

function mountMoreTime(request) {
	const { body } = shell();
	body.textContent = "";
	const note = document.createElement("div");
	note.className = "surface-hint";
	note.textContent = `“${request.title ?? "This question"}” reached its timeout. Keep it open?`;
	body.append(note);
	const actions = actionRow();
	const more = document.createElement("button");
	more.type = "button";
	more.className = "primary";
	more.textContent = "more time";
	more.addEventListener("click", () => finishMoreTime(true));
	const shelve = document.createElement("button");
	shelve.type = "button";
	shelve.textContent = "shelve it";
	shelve.addEventListener("click", () => finishMoreTime(false));
	actions.append(more, shelve);
	body.append(actions);
}

function mountBody(request) {
	const { body } = shell();
	body.textContent = "";
	const title = titleOf(request);

	if (request.method === "more_time") {
		mountMoreTime(request);
		return;
	}

	if (request.method === "reask") {
		mountReask(request);
		return;
	}

	if (request.method === "panel") {
		const id = request.id;
		openPanel(request, body, {
			submit: (value) => finishSurface({ value: typeof value === "string" ? value : JSON.stringify(value) }),
			cancel: () => finishSurface({ cancelled: true }),
			setTitle: (text) => {
				if (typeof text !== "string" || !text.trim()) return;
				panelTitles.set(id, text.trim());
				shell().title.textContent = text.trim();
			},
		});
		return;
	}

	if (request.method === "select") {
		const actions = actionRow();
		for (const option of Array.isArray(request.options) ? request.options : []) {
			addButton(actions, String(option), { value: option });
		}
		addButton(actions, "cancel", { cancelled: true });
		body.append(actions);
		return;
	}

	if (request.method === "confirm") {
		const actions = actionRow();
		addButton(actions, request.yesLabel ?? "yes", { confirmed: true }, "primary");
		addButton(actions, request.noLabel ?? "no", { confirmed: false });
		addButton(actions, "cancel", { cancelled: true });
		body.append(actions);
		return;
	}

	const hint = document.createElement("div");
	hint.className = "surface-hint";
	hint.textContent = request.message ?? title;
	const field = document.createElement(request.method === "editor" ? "textarea" : "input");
	if (request.method === "editor")
		field.rows = Math.min(12, Math.max(4, String(request.prefill ?? "").split("\n").length));
	else field.type = "text";
	field.value = request.value ?? request.initialValue ?? request.prefill ?? "";
	field.className = "surface-field";
	const actions = actionRow();
	const submit = () => finishSurface({ value: field.value });
	const send = document.createElement("button");
	send.type = "button";
	send.textContent = "send";
	send.className = "primary";
	send.addEventListener("click", submit);
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "cancel";
	cancel.addEventListener("click", () => finishSurface({ cancelled: true }));
	actions.append(send, cancel);
	field.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && (!event.shiftKey || request.method !== "editor")) {
			event.preventDefault();
			submit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			finishSurface({ cancelled: true });
		}
	});
	body.append(hint, field, actions);
}

export function renderSurface({ force = false } = {}) {
	const root = ui.surface;
	if (!root) return;
	syncComposer();
	if (!queue.active) {
		root.hidden = true;
		root.textContent = "";
		root.classList.remove("collapsed", "expanded");
		renderedId = null;
		lastShell = null;
		lastSurfaceHeight = 0;
		syncOffset();
		return;
	}
	observeSurface();
	const elements = shell();
	root.hidden = false;
	root.classList.toggle("collapsed", collapsed);
	root.classList.toggle("expanded", !collapsed);
	elements.title.textContent = titleOf(queue.active);
	elements.status.textContent = queue.queued.length
		? `${queue.active.method ?? "request"} · ${queue.queued.length} waiting`
		: `${queue.active.method ?? "request"} · waiting for you`;
	elements.collapse.textContent = collapsed ? "expand" : "collapse";
	elements.collapse.setAttribute("aria-expanded", String(!collapsed));
	elements.banner.hidden = queue.queued.length === 0;
	elements.bannerText.textContent =
		queue.queued.length === 1 ? "1 new request waiting" : `${queue.queued.length} new requests waiting`;
	if (force || renderedId !== queue.active.id) {
		renderedId = queue.active.id;
		mountBody(queue.active);
	}
	syncOffset();
}

/** Route one blocking extension UI request to the inline surface. */
export function openSurfaceRequest(request) {
	if (!BLOCKING.includes(request?.method)) return false;
	if (request.method === "panel" && pendingReaskDraft !== undefined) {
		setPanelDraft(request.id, pendingReaskDraft);
		pendingReaskDraft = undefined;
	}
	const before = queue.active?.id;
	const position = logPosition();
	const wasCollapsed = collapsed;
	enqueueSurface(queue, request);
	if (queue.active?.id !== before) collapsed = false;
	else collapsed = wasCollapsed;
	renderSurface();
	restoreLog(position);
	return true;
}

/** Switch a visible request to the "Do you need more time?" card. */
export function handleNeedTime(frame) {
	const id = String(frame?.id ?? "");
	if (!id || queue.active?.id !== id) return;
	const original = queue.active;
	const title = typeof frame.title === "string" && frame.title.trim() ? frame.title.trim() : titleOf(original);
	savePanelDraft(id);
	closePanel(id, { discard: false });
	queue.active = { id: `more:${id}`, method: "more_time", requestId: id, original, title };
	collapsed = false;
	renderSurface();
}

/** Keep the pending request alive, or shelve it with its saved draft. */
export function finishMoreTime(more) {
	const active = queue.active;
	if (active?.method !== "more_time") return;
	const id = active.requestId;
	const position = logPosition();
	if (more) {
		send({ t: "ui_more_time", id, more: true });
		queue.active = active.original;
	} else {
		const draft = panelDraft(id);
		send({ t: "ui_more_time", id, more: false, ...(draft !== undefined ? { draft } : {}) });
		settleSurface(queue, active.id);
	}
	collapsed = false;
	renderSurface();
	restoreLog(position);
}

/** Show recorded timed-out requests as re-ask cards. */
export function handleReasks(requests) {
	for (const record of Array.isArray(requests) ? requests : []) {
		if (!record || typeof record.id !== "string") continue;
		openSurfaceRequest({
			id: `reask:${record.id}`,
			method: "reask",
			reask: record,
			panelId: `reask-panel:${record.id}`,
		});
	}
}

/** Exactly-once answer/cancel for the active request. */
export function finishSurface(fields) {
	const active = queue.active;
	if (!active) return;
	if (active.method === "reask") {
		finishReask(fields?.cancelled ? "dismiss" : "ask");
		return;
	}
	const position = logPosition();
	if (active.method === "panel") {
		panelTitles.delete(active.id);
		closePanel(active.id, { discard: true });
	}
	send({ t: "ui", id: active.id, ...fields });
	settleSurface(queue, active.id);
	collapsed = false;
	renderSurface();
	restoreLog(position);
}

/** Ask the agent to re-issue, or forget, one recorded timed-out request. */
export function finishReask(action) {
	const active = queue.active;
	if (active?.method !== "reask") return;
	const position = logPosition();
	if (action === "ask" && active.reask?.draft !== undefined) pendingReaskDraft = active.reask.draft;
	closePanel(active.panelId, { discard: true });
	send({ t: "reask", id: active.reask.id, action });
	settleSurface(queue, active.id);
	collapsed = false;
	renderSurface();
	restoreLog(position);
}

/** Retire one timed-out request without sending an answer to Pi. */
export function dropSurface(id) {
	const active = queue.active;
	if (active?.method === "more_time" && active.requestId === id) {
		settleSurface(queue, active.id);
		renderSurface();
		return;
	}
	if (active?.id === id) {
		if (active.method === "panel") closePanel(active.id, { discard: false });
		if (active.method === "reask") closePanel(active.panelId, { discard: true });
	}
	settleSurface(queue, id);
	renderSurface();
}

export function cancelSurface() {
	finishSurface({ cancelled: true });
}

/** Cancel without sending: only for leaving the session or replacing the view. */
export function resetSurface() {
	closeAllPanels({ discard: false });
	panelTitles.clear();
	queue.active = null;
	queue.queued.length = 0;
	collapsed = false;
	renderedId = null;
	lastShell = null;
	if (ui.surface) {
		ui.surface.hidden = true;
		ui.surface.textContent = "";
		ui.surface.classList.remove("collapsed", "expanded");
		lastSurfaceHeight = 0;
		syncOffset();
	}
	syncComposer();
}

export function surfaceOpen() {
	return queue.active !== null;
}

/** Dev-only: open an A2UI fixture panel from `?panel=fixture`, `?panel=long`
 * (overflow fixture), `?panel=tabs` (many-tabs fixture) or `?panel=questionnaire`
 * (questionnaire surface fixture). */
export async function openFixturePanel(search = location.search) {
	const params = new URLSearchParams(search);
	const panel = params.get("panel");
	if (panel !== "fixture" && panel !== "long" && panel !== "tabs" && panel !== "questionnaire") return false;
	let payload;
	try {
		const fixture = panel === "fixture" ? "" : `?fixture=${panel}`;
		const response = await fetch(`/api/dev/panel-fixture${fixture}`, { cache: "no-store" });
		if (!response.ok) return false;
		payload = await response.json();
	} catch {
		return false;
	}
	return openSurfaceRequest({ id: `fixture-${Date.now()}`, method: "panel", payload });
}

export function surfaceStatus() {
	return {
		active: queue.active,
		queued: [...queue.queued],
		collapsed,
	};
}

/** Put a cached request/queue back after returning to a parked session. */
export function restoreSurface(status) {
	queue.active = status?.active ?? null;
	queue.queued = Array.isArray(status?.queued) ? [...status.queued] : [];
	collapsed = status?.collapsed === true;
	renderedId = null;
	renderSurface({ force: Boolean(queue.active) });
}

import {
	ansiToHtml,
	bashCardHtml,
	escapeHtml,
	relativeTime,
	renderAssistant,
	renderAssistantBody,
	renderEntry,
	pendingErrorHtml,
	pendingSessionHtml,
	summarizeArgs,
	textOf,
	toolBlock,
	toolCallsOf,
} from "./render.js";
import { classifyInput, commandQuery, filterCommands, isAllowed, menuCatalog, menuInsertText } from "./commands.js";
import { crumbTrail, filterDirEntries, initialDirectory, parentDirectory } from "./directoryPicker.js";
import { queueCount, queueFromEvent, queueTexts, restoreText } from "./queue.js";
import { flattenTree } from "./tree.js";
import { addonStatusText, addonWidgets, applyAddonUi, createAddonUi } from "./addonUi.js";
import { createSessionCache } from "./sessionCache.js";
import { formatSession } from "./sessionInfo.js";
import {
	contextLevel,
	footerPwdLine,
	footerStatsLeft,
	footerStatsRight,
} from "./footer.js";
import {
	COLLAPSED_STORAGE_KEY,
	KEEP_ACTIVE_STORAGE_KEY,
	countLabel,
	groupBranch,
	groupLabel,
	groupSessions,
	groupView,
	parseCollapsed,
	parseKeepActive,
	serializeCollapsed,
	serializeKeepActive,
} from "./sessionGroups.js";
import {
	DEFAULT_PERCENT,
	STORAGE_KEY,
	STEPS,
	clampPercent,
	decreaseLabel,
	increaseLabel,
	nextPercent,
	parseStored,
	previousPercent,
	scaleFactor,
} from "./transcriptScale.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
	bar: $("#bar"),
	back: $("#back"),
	title: $("#title"),
	sub: $("#sub"),
	dot: $("#dot"),
	settings: $("#settings"),
	reload: $("#reload"),
	stop: $("#stop"),
	scaleDown: $("#scale-down"),
	scaleUp: $("#scale-up"),
	scaleValue: $("#scale-value"),
	list: $("#list"),
	session: $("#session"),
	log: $("#log"),
	dock: $("#dock"),
	menu: $("#menu"),
	queue: $("#queue"),
	composer: $("#composer"),
	input: $("#input"),
	send: $("#send"),
	footer: $("#footer"),
	footerAbove: $("#footer .addon-widgets.above"),
	footerStatuses: $("#footer .addon-statuses"),
	footerBelow: $("#footer .addon-widgets.below"),
	sheet: $("#sheet"),
	toast: $("#toast"),
};

const state = {
	sessionId: null,
	sessionCache: createSessionCache(8), // recently viewed transcripts, in-memory only
	info: null,
	ws: null,
	retries: 0,
	stick: true,
	streaming: null, // { section, text }
	pendingUser: null,
	restarting: false, // old daemon announced a restart; socket is about to close
	restartWasBusy: false, // a turn was in flight when the restart was announced
	restartNoticePending: false, // paint the interruption notice after the reconnect snapshot
	pendingCreate: null, // dashboard `new` action waiting for the first session id
	uiDialog: null, // extension_ui_request currently shown as a modal, if any
	tools: new Map(), // toolCallId -> <details>
	coarse: window.matchMedia("(pointer: coarse)").matches,
	renderQueued: false,
	footer: null,
	addon: createAddonUi(), // Pi extension setStatus/setWidget state
	models: [],
	levels: [],
	dynamicCommands: [], // live get_commands entries for the `/` menu
	menu: { items: [], index: 0 },
	queue: { steering: [], followUp: [] }, // Pi's pending steer/follow-up texts
	policy: null, // effective per-session command policy (hub-resolved)
	bashRunning: false,
	quitting: false,
	bash: new Map(), // bash id -> optimistic card, matched by event id
	entries: [], // what the client currently knows, oldest first
	more: false, // older entries exist before entries[0]
	loadingEarlier: false,
	scale: DEFAULT_PERCENT, // transcript text size, percent (device-local)
	home: "", // $HOME for dashboard path shortening (device-local cache)
	defaultCwd: "", // last discovery value, so list refreshes do not clear the form
	sessions: [], // last dashboard list, for local re-renders
	collapsed: readCollapsedGroups(), // cwd key -> true when collapsed
	keepActive: readKeepActive(), // pin hot/warm/newest when collapsed
};

// ------------------------------------------------------------------ transport

function socketUrl(sessionId) {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	// Reconnect with the durable entry cursor when this page already holds the
	// transcript: the hub then sends only the delta instead of the full window.
	const cursor = sessionId && state.sessionId === sessionId ? lastEntryId() : null;
	if (cursor) params.set("since", cursor);
	const query = params.toString();
	return `${scheme}://${location.host}/ws${query ? `?${query}` : ""}`;
}

function connect(sessionId) {
	closeSocket();
	const ws = new WebSocket(socketUrl(sessionId));
	state.ws = ws;
	ws.onopen = () => {
		state.retries = 0;
	};
	ws.onmessage = (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		handleFrame(frame);
	};
	ws.onclose = () => {
		if (state.ws !== ws) return;
		state.ws = null;
		// A dropped socket does not kill the child, but this page no longer tracks
		// the card or the one-at-a-time guard; the snapshot restores the transcript.
		state.bashRunning = false;
		state.bash.clear();
		if (state.pendingCreate) {
			failPendingSession("daemon disconnected");
			return;
		}
		if (!state.sessionId) return;
		const delay = Math.min(2000, 200 * 2 ** state.retries++);
		toast(state.restarting ? `pixip restarting — reconnecting… (${delay}ms)` : `reconnecting… (${delay}ms)`);
		setTimeout(() => connect(state.sessionId), delay);
	};
}

function closeSocket() {
	if (state.ws) {
		const ws = state.ws;
		state.ws = null;
		ws.onclose = null;
		ws.close();
	}
}

function send(frame) {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(frame));
}

// -------------------------------------------------------------------- routing

function route() {
	const match = /^#s=(.+)$/.exec(location.hash);
	const id = match ? decodeURIComponent(match[1]) : null;
	if (id) openSession(id);
	else if (location.hash === "#new") {
		// A reload lands here without a create in flight: fall back to the dashboard.
		if (!state.pendingCreate) {
			history.replaceState(null, "", "");
			void showList();
		}
	} else showList();
}

async function showList() {
	cacheCurrentSession();
	state.sessionId = null;
	state.info = null;
	state.pendingCreate = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	state.restarting = false;
	state.restartWasBusy = false;
	state.restartNoticePending = false;
	state.policy = null;
	state.dynamicCommands = [];
	state.queue = { steering: [], followUp: [] };
	renderQueue();
	closeMenu();
	state.bashRunning = false;
	state.quitting = false;
	state.bash.clear();
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
	ui.session.hidden = true;
	ui.composer.hidden = true;
	ui.footer.hidden = true;
	ui.dock.hidden = true;
	ui.stop.hidden = true;
	ui.back.hidden = true;
	ui.settings.hidden = false;
	ui.list.hidden = false;
	ui.title.textContent = "sessions";
	ui.sub.textContent = "";
	ui.dot.className = "dot idle";
	ui.dot.hidden = true;
	document.title = "pixip";

	connect(null);

	let info = {};
	try {
		info = await (await fetch("/api/info")).json();
		if (typeof info.defaultCwd === "string") state.defaultCwd = info.defaultCwd;
		if (typeof info.home === "string") state.home = info.home;
	} catch {}
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}

async function listSessions() {
	try {
		return await (await fetch("/api/sessions")).json();
	} catch {
		return [];
	}
}

async function apiJson(path, options = {}) {
	const response = await fetch(path, options);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
	return body;
}

async function refreshDashboard() {
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}

function renderList(sessions, defaultCwd = state.defaultCwd, home = state.home) {
	// A list refresh (or a local toggling re-render) must not discard a path the
	// user is typing into the new-session form.
	const draft = ui.list.querySelector("#new-row input")?.value;
	state.sessions = Array.isArray(sessions) ? sessions : [];
	if (typeof defaultCwd === "string") state.defaultCwd = defaultCwd;
	if (typeof home === "string") state.home = home;
	ui.list.textContent = "";
	const form = document.createElement("form");
	form.id = "new-row";
	const value = draft !== undefined ? draft : state.defaultCwd ?? "";
	form.innerHTML = `<input name="cwd" value="${escapeHtml(value)}" placeholder="/path/to/project" autocapitalize="off" autocorrect="off" spellcheck="false" /><button type="button" class="browse">browse</button><button type="submit">new</button>`;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const cwd = form.querySelector("input")?.value?.trim();
		if (cwd) beginNewSession(cwd);
	});
	form.querySelector(".browse")?.addEventListener("click", () => {
		void openDirectorySheet(initialDirectory(state.defaultCwd, state.home));
	});
	ui.list.append(form);

	const inactive = state.sessions.filter((session) => session.state === "stopped");
	if (inactive.length > 0) {
		const bulk = document.createElement("button");
		bulk.type = "button";
		bulk.className = "bulk-archive";
		bulk.textContent = `archive inactive (${inactive.length})`;
		bulk.title = "Archive every stopped session on the dashboard";
		bulk.addEventListener("click", () => void archiveInactive(inactive.length));
		ui.list.append(bulk);
	}

	const groups = groupSessions(state.sessions);
	if (groups.length === 0) {
		const empty = document.createElement("div");
		empty.className = "row row-state";
		empty.textContent = "no sessions yet";
		ui.list.append(empty);
		return;
	}
	for (const group of groups) ui.list.append(renderGroup(group));
}

// -------------------------------------------------- directory picker (00)

const picker = {
	path: "",
	listing: null,
	filter: "",
	notice: "",
	loading: false,
	token: 0,
};

let pickerUi = null;

function setNewCwd(path) {
	const input = ui.list.querySelector("#new-row input");
	if (!input) return;
	input.value = path;
	input.focus();
}

async function openDirectorySheet(startPath) {
	picker.filter = "";
	picker.notice = "";
	picker.listing = null;
	await loadDirectory(startPath, true);
}

async function loadDirectory(path, resetFilter = false) {
	const token = ++picker.token;
	if (resetFilter) picker.filter = "";
	picker.path = path;
	picker.loading = true;
	picker.notice = "";
	renderDirectorySheet();
	try {
		const listing = await apiJson(`/api/dirs?path=${encodeURIComponent(path)}`);
		if (token !== picker.token) return;
		picker.listing = listing;
		picker.path = String(listing.path ?? path);
	} catch (error) {
		if (token !== picker.token) return;
		picker.listing = null;
		picker.notice = error.message;
	} finally {
		if (token === picker.token) {
			picker.loading = false;
			renderDirectorySheet();
		}
	}
}

function renderDirectorySheet() {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";

	const content = document.createElement("div");
	content.className = "dir-sheet";

	const heading = sheetHeader("choose directory");

	const crumbs = document.createElement("div");
	crumbs.className = "dir-crumbs";
	for (const crumb of crumbTrail(picker.path, state.home)) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "dir-crumb";
		button.textContent = crumb.label;
		button.title = crumb.path;
		button.disabled = crumb.path === picker.path;
		button.addEventListener("click", () => void loadDirectory(crumb.path, true));
		crumbs.append(button);
	}

	const filter = document.createElement("input");
	filter.className = "dir-filter";
	filter.type = "search";
	filter.placeholder = "filter directories…";
	filter.value = picker.filter;
	filter.autocapitalize = "off";
	filter.autocorrect = "off";
	filter.spellcheck = false;
	filter.setAttribute("aria-label", "Filter directories");
	filter.addEventListener("input", () => {
		picker.filter = filter.value;
		updateDirectoryList();
	});

	const error = document.createElement("div");
	error.className = "dir-error";
	error.hidden = true;

	const list = document.createElement("div");
	list.className = "dir-list";

	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const use = document.createElement("button");
	use.type = "button";
	use.className = "dir-use";
	use.textContent = "use this directory";
	use.disabled = !picker.listing;
	use.addEventListener("click", () => {
		if (!picker.listing) return;
		setNewCwd(picker.listing.path);
		closeSheet();
	});
	const folder = document.createElement("button");
	folder.type = "button";
	folder.textContent = "new folder";
	folder.disabled = !picker.listing;
	folder.addEventListener("click", () => showNewFolderForm());
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(use, folder, close);

	content.append(heading, crumbs, filter, error, list, actions);
	target.append(content);
	pickerUi = { sheet: target, list, error, actions };
	updateDirectoryList();
}

function dirMessage(text) {
	const row = document.createElement("div");
	row.className = "dir-empty";
	row.textContent = text;
	return row;
}

function dirButton(label, path, repo, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "dir-row";
	button.title = title ?? path;
	const name = document.createElement("span");
	name.className = "dir-name";
	name.textContent = label;
	button.append(name);
	if (repo) {
		const badge = document.createElement("span");
		badge.className = "dir-badge";
		badge.textContent = "git";
		button.append(badge);
	}
	button.addEventListener("click", () => void loadDirectory(path, true));
	return button;
}

function updateDirectoryList() {
	if (!pickerUi) return;
	const { list, error } = pickerUi;
	list.textContent = "";
	error.hidden = true;
	if (picker.loading) {
		list.append(dirMessage("loading…"));
		return;
	}
	if (picker.notice) {
		error.textContent = picker.notice;
		error.hidden = false;
	}
	const listing = picker.listing;
	if (!listing) {
		list.append(dirMessage("no directory loaded"));
		return;
	}
	const parent = parentDirectory(listing.path, listing.home ?? state.home);
	if (parent) {
		const up = dirButton("..", parent, false, parent);
		up.classList.add("dir-parent");
		list.append(up);
	}
	const entries = filterDirEntries(listing.entries, picker.filter);
	for (const entry of entries) list.append(dirButton(entry.name, entry.path, Boolean(entry.repo), entry.path));
	if (entries.length === 0) list.append(dirMessage(picker.filter ? "no matching directories" : "no subdirectories"));
}

function showNewFolderForm() {
	if (!pickerUi || !picker.listing) return;
	const existing = pickerUi.sheet.querySelector(".dir-mkdir");
	if (existing) {
		existing.querySelector("input")?.focus();
		return;
	}
	const form = document.createElement("form");
	form.className = "dir-mkdir";
	form.innerHTML = `<input name="name" placeholder="new folder name" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" /><button type="submit">create</button>`;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const name = form.querySelector("input")?.value?.trim() ?? "";
		if (name) void createPickerFolder(name);
	});
	pickerUi.actions.before(form);
	form.querySelector("input")?.focus();
}

async function createPickerFolder(name) {
	if (!picker.listing) return;
	try {
		const result = await apiJson("/api/dirs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: picker.listing.path, name }),
		});
		await loadDirectory(result.path ?? picker.listing.path, true);
	} catch (error) {
		if (!pickerUi) return;
		pickerUi.error.textContent = error.message;
		pickerUi.error.hidden = false;
	}
}

function renderGroup(group) {
	const section = document.createElement("section");
	section.className = "group";
	section.dataset.cwd = group.key;
	// Open states persist; a group seen for the first time starts collapsed.
	const collapsed = state.collapsed[group.key] !== false;
	const view = groupView(group, collapsed, state.keepActive);
	// The toggle exists when collapsing would actually hide a row, even while the
	// group is open (expanded `view.hidden` is always 0 by definition).
	const canToggle = groupView(group, true, state.keepActive).hidden > 0;
	const head = document.createElement("div");
	head.className = "group-head";
	const control = document.createElement(canToggle ? "button" : "div");
	control.className = canToggle ? "group-toggle" : "group-title";
	if (canToggle) {
		control.type = "button";
		control.setAttribute("aria-expanded", String(!collapsed));
		control.addEventListener("click", () => {
			state.collapsed[group.key] = !collapsed;
			saveCollapsedGroups();
			renderList(state.sessions);
		});
		const chevron = document.createElement("span");
		chevron.className = "group-chevron";
		chevron.textContent = collapsed ? "▸" : "▾";
		control.append(chevron);
	}
	const path = document.createElement("span");
	path.className = "group-path";
	path.textContent = groupLabel(group, state.home);
	path.title = group.key || "unknown cwd";
	const branch = groupBranch(group);
	const count = document.createElement("span");
	count.className = "group-count";
	count.textContent = countLabel(group.sessions.length, view.hidden);
	control.append(path);
	if (branch) {
		const chip = document.createElement("span");
		chip.className = "group-branch";
		chip.textContent = branch;
		chip.title = `git branch ${branch}`;
		control.append(chip);
	}
	control.append(count);
	head.append(control);
	if (group.cwd) {
		const add = document.createElement("button");
		add.type = "button";
		add.className = "group-new";
		add.textContent = "+";
		add.title = "new session here";
		add.setAttribute("aria-label", `New session in ${groupLabel(group, state.home)}`);
		add.addEventListener("click", () => send({ t: "create", cwd: group.cwd }));
		head.append(add);
	}
	section.append(head);
	if (view.rows.length > 0) {
		const rows = document.createElement("div");
		rows.className = "group-rows";
		for (const session of view.rows) rows.append(sessionRow(session));
		section.append(rows);
	}
	return section;
}

function sessionRow(session) {
	const row = document.createElement("div");
	row.className = "row";
	row.dataset.id = session.id;
	const open = document.createElement("button");
	open.type = "button";
	open.className = "row-open";
	const stateClass = escapeHtml(session.state);
	open.innerHTML = `<div class="row-top"><span class="dot ${stateClass}"></span><span class="row-name">${escapeHtml(session.name ?? session.id.slice(0, 8))}</span><span class="row-state">${stateClass} · ${relativeTime(session.lastActivity)}</span></div>`;
	open.addEventListener("click", () => {
		location.hash = `s=${encodeURIComponent(session.id)}`;
	});
	const actions = document.createElement("button");
	actions.type = "button";
	actions.className = "row-actions";
	actions.textContent = "⋯";
	actions.title = "Session actions";
	actions.setAttribute("aria-label", `Actions for ${session.name ?? session.id.slice(0, 8)}`);
	actions.addEventListener("click", () => openSessionActions(session));
	row.append(open, actions);
	return row;
}

function openSessionActions(session) {
	const label = session.name ?? session.id.slice(0, 8);
	sheet(`session · ${label}`, [
		["archive", () => confirmSessionAction("archive", session)],
		["delete", () => confirmSessionAction("delete", session)],
	]);
}

function confirmSessionAction(kind, session) {
	const label = session.name ?? session.id.slice(0, 8);
	const verb = kind === "archive" ? "archive" : "delete";
	const message =
		kind === "archive"
			? `Hide “${label}” from the dashboard? You can restore it from settings › archived.`
			: `Delete “${label}”? The JSONL files go to trash and stay undoable for a few seconds.`;
	confirmSheet(verb, message, verb, () => {
		closeSheet();
		void (kind === "archive" ? archiveSession(session) : deleteSession(session));
	});
}

function confirmSheet(title, message, confirmLabel, action) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(title);
	const body = document.createElement("div");
	body.className = "sheet-text";
	body.textContent = message;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const confirm = document.createElement("button");
	confirm.textContent = confirmLabel;
	confirm.classList.add("danger");
	confirm.addEventListener("click", action);
	const cancel = document.createElement("button");
	cancel.textContent = "cancel";
	cancel.addEventListener("click", closeSheet);
	actions.append(confirm, cancel);
	target.append(heading, body, actions);
}

async function archiveSession(session) {
	try {
		await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
		forgetCachedSession(session);
		await refreshDashboard();
		toast("archived");
	} catch (error) {
		toast(`archive failed: ${error.message}`);
	}
}

async function deleteSession(session) {
	try {
		const result = await apiJson(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
		forgetCachedSession(session);
		await refreshDashboard();
		const token = result?.undo?.token;
		if (token) {
			actionToast(`deleted ${session.name ?? session.id.slice(0, 8)}`, "undo", async () => {
				try {
					await apiJson(`/api/trash/${encodeURIComponent(token)}/restore`, { method: "POST" });
					await refreshDashboard();
					toast("restored");
				} catch (error) {
					toast(`restore failed: ${error.message}`);
				}
			}, 10_000);
		} else {
			toast("deleted");
		}
	} catch (error) {
		toast(`delete failed: ${error.message}`);
	}
}

async function archiveInactive(count) {
	if (!window.confirm(`Archive ${count} inactive session${count === 1 ? "" : "s"}?`)) return;
	try {
		const result = await apiJson("/api/sessions/archive-inactive", { method: "POST" });
		if (Array.isArray(result.archived)) for (const session of result.archived) forgetCachedSession(session);
		await refreshDashboard();
		const failed = Array.isArray(result.failed) ? result.failed.length : 0;
		toast(`archived ${result.archived ?? 0}${failed ? ` · ${failed} failed` : ""}`);
	} catch (error) {
		toast(`archive failed: ${error.message}`);
	}
}

function readCollapsedGroups() {
	try {
		return parseCollapsed(localStorage.getItem(COLLAPSED_STORAGE_KEY));
	} catch {
		return {};
	}
}

function saveCollapsedGroups() {
	try {
		localStorage.setItem(COLLAPSED_STORAGE_KEY, serializeCollapsed(state.collapsed));
	} catch {}
}

function readKeepActive() {
	try {
		return parseKeepActive(localStorage.getItem(KEEP_ACTIVE_STORAGE_KEY));
	} catch {
		return true;
	}
}

function saveKeepActive() {
	try {
		localStorage.setItem(KEEP_ACTIVE_STORAGE_KEY, serializeKeepActive(state.keepActive));
	} catch {}
}

async function openSettingsSheet() {
	let archived = [];
	let trash = [];
	try {
		[archived, trash] = await Promise.all([apiJson("/api/archived"), apiJson("/api/trash")]);
	} catch {
		// The settings toggles still work when the archive/trash lists fail.
	}
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("settings");
	const label = document.createElement("label");
	label.className = "settings-row";
	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.checked = state.keepActive;
	checkbox.addEventListener("change", () => {
		state.keepActive = checkbox.checked;
		saveKeepActive();
		renderList(state.sessions);
	});
	const text = document.createElement("span");
	text.className = "settings-text";
	text.textContent = "Keep hot/warm and newest sessions visible when collapsed";
	label.append(checkbox, text);
	const hint = document.createElement("div");
	hint.className = "settings-hint";
	hint.textContent = "Hot = busy or starting · warm = idle. Off hides every row when a group is collapsed.";
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const archivedButton = document.createElement("button");
	archivedButton.textContent = `archived (${Array.isArray(archived) ? archived.length : 0})`;
	archivedButton.addEventListener("click", () => void showStoredSheet("archive"));
	const trashButton = document.createElement("button");
	trashButton.textContent = `trash (${Array.isArray(trash) ? trash.length : 0})`;
	trashButton.addEventListener("click", () => void showStoredSheet("trash"));
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(archivedButton, trashButton, close);
	target.append(heading, label, hint, actions);
}

async function showStoredSheet(kind) {
	const archived = kind === "archive";
	try {
		const items = await apiJson(archived ? "/api/archived" : "/api/trash");
		renderStoredSheet(kind, Array.isArray(items) ? items : []);
	} catch (error) {
		toast(`load failed: ${error.message}`);
	}
}

function renderStoredSheet(kind, items) {
	const archived = kind === "archive";
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(`${archived ? "archived" : "trash"} (${items.length})`);
	const hint = document.createElement("div");
	hint.className = "settings-hint";
	hint.textContent = archived
		? "Restore a session to the dashboard, or delete its files permanently."
		: "Deleted sessions stay here briefly; undo from the toast or restore below.";
	const list = document.createElement("div");
	list.className = "stored-list";
	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "settings-hint";
		empty.textContent = archived ? "nothing archived" : "trash is empty";
		list.append(empty);
	}
	for (const item of items) {
		const row = document.createElement("div");
		row.className = "stored-row";
		const info = document.createElement("div");
		info.className = "stored-info";
		const name = document.createElement("div");
		name.className = "stored-name";
		name.textContent = item.name ?? String(item.id ?? "").slice(0, 8);
		const meta = document.createElement("div");
		meta.className = "stored-meta";
		meta.textContent = `${groupLabel({ key: item.cwd, cwd: item.cwd }, state.home)} · ${relativeTime(item.lastActivity)}`;
		info.append(name, meta);
		const actions = document.createElement("div");
		actions.className = "stored-actions";
		const restore = document.createElement("button");
		restore.textContent = "restore";
		restore.addEventListener("click", () => void restoreStored(kind, item));
		const remove = document.createElement("button");
		remove.textContent = archived ? "delete" : "purge";
		remove.addEventListener("click", () => void purgeStored(kind, item));
		actions.append(restore, remove);
		row.append(info, actions);
		list.append(row);
	}
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const back = document.createElement("button");
	back.textContent = "settings";
	back.addEventListener("click", () => void openSettingsSheet());
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(back, close);
	target.append(heading, hint, list, actions);
}

async function restoreStored(kind, item) {
	const id = item.logicalId ?? item.id;
	try {
		await apiJson(`/api/${kind === "archive" ? "archived" : "trash"}/${encodeURIComponent(id)}/restore`, { method: "POST" });
		await refreshDashboard();
		toast("restored");
		await showStoredSheet(kind);
	} catch (error) {
		toast(`restore failed: ${error.message}`);
	}
}

async function purgeStored(kind, item) {
	const label = item.name ?? String(item.id ?? "").slice(0, 8);
	if (!window.confirm(`Permanently delete “${label}”?`)) return;
	const id = item.logicalId ?? item.id;
	try {
		await apiJson(`/api/${kind === "archive" ? "archived" : "trash"}/${encodeURIComponent(id)}`, { method: "DELETE" });
		toast("deleted");
		await showStoredSheet(kind);
	} catch (error) {
		toast(`delete failed: ${error.message}`);
	}
}

function beginNewSession(cwd) {
	state.pendingCreate = { cwd };
	history.pushState(null, "", "#new");
	showPendingSession();
	// The dashboard socket is still open; the `opened` frame will carry the id.
	send({ t: "create", cwd });
}

function showPendingSession() {
	state.sessionId = null;
	state.info = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
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
	ui.send.disabled = true;
	document.title = "new session · pixip";
}

function failPendingSession(message) {
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
	ui.send.disabled = true;
	document.title = "new session · pixip";
}

function openSession(id) {
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
	state.stick = true;
	ui.title.textContent = "connecting…";
	ui.sub.textContent = id.slice(0, 8);
	ui.dot.className = "dot busy";
	document.title = "pixip";
	const cached = state.sessionCache.get(id);
	if (cached) restoreCachedSession(cached);
	else ui.input.value = "";
	connect(id);
}

/** Snapshot the current route before leaving it; the next open paints this. */
function cacheCurrentSession() {
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

/** Repaint a cached route synchronously, before its socket snapshot arrives. */
function restoreCachedSession(cached) {
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

/** Archive/delete must not leave a stale transcript behind the same id. */
function forgetCachedSession(session) {
	if (!session) return;
	state.sessionCache.delete(session.id);
	if (typeof session.logicalId === "string") state.sessionCache.delete(session.logicalId);
}

// --------------------------------------------------------------------- frames

function handleFrame(frame) {
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
			openTreeSheet(Array.isArray(frame.tree) ? frame.tree : [], typeof frame.leafId === "string" ? frame.leafId : null);
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

function applyInfo() {
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
	ui.input.disabled = restarting || stopped || starting;
	ui.send.disabled = restarting || stopped || starting;
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

// ---------------------------------------------------------------- snapshot

/** Bytes of DOM a 200-entry window costs; the first paint only pays for a slice. */
const FIRST_PAINT_BYTES = 24 * 1024;
const FILL_CHUNK_BYTES = 32 * 1024;

let fillTimer = 0;
let fillToken = 0;

/**
 * Merge an incoming window (provisional tail or authoritative snapshot) into the
 * client's entries. Windows the user already loaded stay; duplicates are dropped
 * in favour of the newer copy.
 */
function mergeTail(entries, more) {
	const previous = state.entries;
	const ids = new Set(entries.map((entry) => entry?.id).filter(Boolean));
	const cut = previous.findIndex((entry) => entry?.id && ids.has(entry.id));
	const keep = cut > 0 ? cut : 0;
	const merged = [...previous.slice(0, keep), ...entries];
	const seen = new Set();
	const out = [];
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		const entry = merged[index];
		const id = entry?.id;
		if (typeof id === "string") {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(entry);
	}
	out.reverse();
	state.entries = out;
	state.more = more;
}

function oldestEntryId() {
	return state.entries.find((entry) => typeof entry?.id === "string")?.id ?? null;
}

function lastEntryId() {
	for (let index = state.entries.length - 1; index >= 0; index -= 1) {
		const id = state.entries[index]?.id;
		if (typeof id === "string") return id;
	}
	return null;
}

function earlierButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "earlier";
	button.textContent = state.loadingEarlier ? "loading…" : "load earlier";
	button.disabled = state.loadingEarlier;
	button.addEventListener("click", () => {
		const before = oldestEntryId();
		if (!before || state.loadingEarlier) return;
		state.loadingEarlier = true;
		button.textContent = "loading…";
		button.disabled = true;
		send({ t: "earlier", before });
	});
	return button;
}

/** Rough DOM cost of an entry, used to keep the first paint small. */
function entryWeight(entry) {
	try {
		return JSON.stringify(entry).length;
	} catch {
		return 512;
	}
}

function htmlOf(entries, calls) {
	const blocks = [];
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			blocks.push(renderAssistant(entry.message.content, false));
			continue;
		}
		if (entry?.type === "message" && entry.message?.role === "toolResult") {
			const call = calls.get(entry.message.toolCallId);
			blocks.push(
				toolBlock(
					entry.message.toolName ?? call?.name ?? "tool",
					call ? summarizeArgs(call.name, call.arguments) : "",
					ansiToHtml(textOf(entry.message.content)),
					entry.message.isError ? " error" : "",
					null,
					entry.message.toolCallId ?? "",
				),
			);
			continue;
		}
		blocks.push(renderEntry(entry));
	}
	return blocks.join("");
}

/**
 * Paint `state.entries`: the newest slice synchronously (the first-paint
 * budget), then the rest in chunks above it. `distance` is the target
 * `scrollHeight - scrollTop` (clientHeight for a pinned view), applied after
 * every chunk so prepended content never moves what the reader is looking at.
 * One innerHTML assignment per chunk instead of per entry.
 */
function renderTranscript(distance = null) {
	const restore = () => {
		if (distance !== null) ui.log.scrollTop = Math.max(0, ui.log.scrollHeight - distance);
	};
	clearTimeout(fillTimer);
	fillToken += 1;
	const token = fillToken;

	state.tools.clear();
	const calls = new Map();
	for (const entry of state.entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			for (const call of toolCallsOf(entry.message.content)) calls.set(call.id, call);
		}
	}

	const entries = state.entries;
	let start = entries.length;
	let bytes = 0;
	while (start > 0 && (bytes === 0 || bytes < FIRST_PAINT_BYTES)) {
		start -= 1;
		bytes += entryWeight(entries[start]);
	}
	const older = state.more && oldestEntryId() ? earlierButton() : null;

	ui.log.innerHTML = entries.length === 0
		? '<div class="block meta">no messages yet — say something</div>'
		: htmlOf(entries.slice(start), calls);
	if (older) ui.log.prepend(older);
	restore();
	const trackTools = () => {
		for (const node of ui.log.querySelectorAll("details.tool")) state.tools.set(node.dataset.call, node);
	};
	trackTools();

	// Older entries of the same window fill in above, chunk by chunk. The
	// distance from the bottom is held constant, so a pinned view stays pinned.
	const fill = () => {
		if (token !== fillToken || start === 0) return;
		let from = start;
		let chunkBytes = 0;
		while (from > 0 && chunkBytes < FILL_CHUNK_BYTES) {
			from -= 1;
			chunkBytes += entryWeight(entries[from]);
		}
		ui.log.insertAdjacentHTML("afterbegin", htmlOf(entries.slice(from, start), calls));
		if (older) ui.log.prepend(older);
		restore();
		trackTools();
		start = from;
		if (start > 0) fillTimer = setTimeout(fill, 0);
	};
	if (start > 0) fillTimer = setTimeout(fill, 0);
}

/** Replace the transcript with a new window, keeping the reading position. */
function renderSnapshot(entries, more) {
	// Pinned: stay at the bottom. Elsewhere: keep the same distance from the
	// bottom, which is exactly the same content once new entries are painted.
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	if (state.stick) state.stick = true;
	mergeTail(entries, more);
	renderTranscript(distance);
}

/**
 * Resume delta from the durable cursor: append entries this client did not have
 * yet, keep the loaded window's `more`, and repaint from `state.entries`. Live
 * DOM is replaced by its entries, so a message painted live is neither lost nor
 * painted twice, and `state.entries` stays the resume anchor.
 */
function renderResume(entries) {
	const known = new Set(state.entries.map((entry) => entry?.id).filter(Boolean));
	const fresh = entries.filter((entry) => typeof entry?.id !== "string" || !known.has(entry.id));
	if (fresh.length === 0) return;
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	state.entries = [...state.entries, ...fresh];
	renderTranscript(distance);
}

/** Local, non-transcript notice for the restart: never sent to Pi or persisted. */
function appendRestartNotice(interrupted) {
	const note = document.createElement("div");
	note.className = "block meta restart";
	note.textContent = interrupted
		? "pixip restarted — the previous turn was interrupted"
		: "pixip restarted";
	ui.log.append(note);
	scrollToEnd();
}

/** Prepend one older window, keeping the reading position. */
function prependHistory(entries, more) {
	state.loadingEarlier = false;
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	const known = new Set(state.entries.map((entry) => entry?.id).filter(Boolean));
	const older = entries.filter((entry) => typeof entry?.id !== "string" || !known.has(entry.id));
	if (older.length > 0) state.entries = [...older, ...state.entries];
	state.more = more;
	renderTranscript(distance);
}

// ------------------------------------------------------------------- events

function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	switch (event.type) {
		case "agent_start":
			setBusy(true);
			break;
		case "agent_settled":
			setBusy(false);
			break;
		case "message_start": {
			const message = event.message ?? {};
			if (message.role === "user") {
				state.pendingUser?.remove();
				state.pendingUser = null;
				appendBlock("user", `<div class="who">you</div><div class="text">${ansiToHtml(textOf(message.content))}</div>`, true);
			} else if (message.role === "assistant") {
				// Lazy: the block is created by the first text delta, so a turn that
				// only thinks never leaves an empty labelled block behind.
				state.streaming = null;
			}
			break;
		}
		case "message_update":
			handleDelta(event.assistantMessageEvent ?? {});
			break;
		case "message_end": {
			const message = event.message ?? {};
			if (message.role === "assistant") {
				const body = renderAssistantBody(message.content ?? [], false);
				const section = state.streaming;
				state.streaming = null;
				if (section) {
					if (body) section.innerHTML = `<div class="who">pi</div>${body}`;
					else section.remove();
				} else if (body) {
					appendBlock("assistant", `<div class="who">pi</div>${body}`, true);
				}
			}
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const call of toolCallsOf(message.content)) state.tools.get(call.id)?.setAttribute("data-name", call.name);
			}
			break;
		}
		case "tool_execution_start": {
			const summary = summarizeArgs(event.toolName, event.args);
			if (!event.toolName && !summary) break;
			const html = toolBlock(event.toolName, summary, "", "", null, event.toolCallId);
			const el = appendBlock("", html, true);
			el.classList.add("tool-host");
			if (event.toolCallId && el.firstElementChild) state.tools.set(event.toolCallId, el.firstElementChild);
			break;
		}
		case "tool_execution_update": {
			const el = state.tools.get(event.toolCallId);
			const out = el?.querySelector(".tool-out");
			if (out && event.partialResult) out.textContent = textOf(event.partialResult.content);
			break;
		}
		case "tool_execution_end": {
			const el = state.tools.get(event.toolCallId);
			if (!el) break;
			const out = el.querySelector(".tool-out");
			if (out) out.innerHTML = ansiToHtml(textOf(event.result?.content));
			if (event.isError) el.classList.add("error");
			const time = el.querySelector(".tool-time");
			if (time && event.durationMs) time.textContent = `${event.durationMs}ms`;
			el.classList.remove("empty");
			scheduleScroll();
			break;
		}
		case "bash_execution_update": {
			// Verbatim event, matched by the id the client put on the bash frame.
			const card = state.bash.get(event.id);
			const out = card?.querySelector(".bash-out");
			if (!out || typeof event.delta !== "string") break;
			out.textContent += event.delta;
			card.classList.remove("empty");
			scheduleScroll();
			break;
		}
		case "extension_ui_request":
			handleUiRequest(event);
			break;
		case "queue_update": {
			// The event carries the complete queue: replace, never append.
			state.queue = queueFromEvent(event);
			if (queueCount(state.queue) > 0) {
				// The chips below are the honest pending state; the optimistic echo
				// would otherwise duplicate a message that has not reached Pi yet.
				state.pendingUser?.remove();
				state.pendingUser = null;
			}
			renderQueue();
			break;
		}
		case "session_info_changed":
			if (state.info) state.info.name = event.name;
			applyInfo();
			break;
		case "compaction_end":
			// The compaction entry is not on the live event path and the context
			// window shrank: re-request the transcript the way it is now.
			send({ t: "resnapshot" });
			break;
		case "auto_retry_start":
			toast(`retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? ""}`);
			break;
		case "compaction_start":
			toast(`compacting (${event.reason})…`);
			break;
		case "extension_error":
			toast(`extension error: ${event.error ?? event.message ?? ""}`);
			break;
		default:
			break;
	}
}

function handleDelta(delta) {
	if (delta.type !== "text_delta" && delta.type !== "text_end") return;
	if (!state.streaming) {
		state.streaming = appendBlock(
			"assistant",
			'<div class="who">pi</div><div class="text live-text"></div>',
			true,
		);
	}
	const target = state.streaming.querySelector(".live-text");
	if (!target) return;
	if (delta.type === "text_delta") {
		state.pending ??= "";
		state.pending += delta.delta ?? "";
		scheduleFlush(target);
	} else {
		state.pending = "";
		target.textContent = delta.content ?? target.textContent;
	}
}

function scheduleFlush(target) {
	if (state.renderQueued) return;
	state.renderQueued = true;
	requestAnimationFrame(() => {
		state.renderQueued = false;
		const text = state.pending ?? "";
		state.pending = "";
		if (!text) return;
		target.textContent += text;
		scheduleScroll();
	});
}

// -------------------------------------------------------------------- footer

function renderAddonWidgets(container, placement) {
	const widgets = addonWidgets(state.addon, placement);
	container.hidden = widgets.length === 0;
	container.textContent = "";
	for (const widget of widgets) {
		const row = document.createElement("div");
		row.className = "addon-widget";
		row.dataset.key = widget.key;
		// Addon text may carry ANSI styling; ansiToHtml escapes all markup.
		row.innerHTML = ansiToHtml(widget.lines.join("\n"));
		container.append(row);
	}
}

function renderFooter() {
	const footer = state.footer;
	const status = addonStatusText(state.addon);
	ui.footerStatuses.hidden = status.length === 0;
	ui.footerStatuses.innerHTML = ansiToHtml(status);
	renderAddonWidgets(ui.footerAbove, "above");
	renderAddonWidgets(ui.footerBelow, "below");
	if (!footer) return;
	const pwd = ui.footer.querySelector(".pwd");
	const left = ui.footer.querySelector(".left");
	const right = ui.footer.querySelector(".right");
	pwd.textContent = footerPwdLine(footer);
	left.textContent = footerStatsLeft(footer);
	left.dataset.level = contextLevel(footer);
	right.textContent = footerStatsRight(footer);
}

ui.footer.addEventListener("click", () => {
	if (!state.sessionId) return;
	openSessionSheet();
});

function openSessionSheet() {
	const footer = state.footer;
	sheet("session", [
		[
			`model: ${footer?.model?.id ?? "unknown"}`,
			() => {
				send({ t: "models" });
			},
		],
		[
			`thinking: ${footer?.thinking ?? "unknown"}`,
			() => {
				send({ t: "thinking" });
			},
		],
	]);
}

function openModelSheet(current) {
	const items = state.models.map((model) => [
		`${model.id === current ? "✓ " : ""}${model.id}${model.provider ? ` · ${model.provider}` : ""}`,
		() => {
			send({ t: "set_model", provider: model.provider, modelId: model.id });
			closeSheet();
		},
	]);
	sheet("model", items.length > 0 ? items : [["no models configured", () => closeSheet()]]);
}

function openThinkingSheet(current) {
	const items = state.levels.map((level) => [
		`${level === current ? "✓ " : ""}${level}`,
		() => {
			send({ t: "set_thinking", level });
			closeSheet();
		},
	]);
	sheet("thinking", items.length > 0 ? items : [["no levels reported", () => closeSheet()]]);
}

/** Bottom sheet with a title and one button per action. */
function sheet(title, items) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(title);
	target.append(heading);
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	for (const [label, action] of items) {
		const button = document.createElement("button");
		button.textContent = label;
		if (label.startsWith("✓ ")) button.classList.add("current");
		button.addEventListener("click", action);
		actions.append(button);
	}
	const cancel = document.createElement("button");
	cancel.textContent = "close";
	cancel.addEventListener("click", closeSheet);
	actions.append(cancel);
	target.append(actions);
}

function closeSheet() {
	ui.sheet.hidden = true;
	ui.sheet.textContent = "";
	state.uiDialog = null;
}

/** Shared x affordance for every modal/sheet. */
function sheetCloseButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "sheet-close";
	button.setAttribute("aria-label", "close");
	button.textContent = "×";
	button.addEventListener("click", dismissSheet);
	return button;
}

/** Title row with the x on the right; the baseline header for every sheet. */
function sheetHeader(title) {
	const header = document.createElement("div");
	header.className = "sheet-header";
	const heading = document.createElement("div");
	heading.className = "sheet-title";
	heading.textContent = title;
	header.append(heading, sheetCloseButton());
	return header;
}

/** Header row for field-first dialogs, where the title is a hint below the field. */
function sheetCloseRow() {
	const header = document.createElement("div");
	header.className = "sheet-header close-only";
	header.append(sheetCloseButton());
	return header;
}

/** x/Escape: cancel a pending Pi dialog exactly once, otherwise close the sheet. */
function dismissSheet() {
	const dialog = state.uiDialog;
	if (!dialog) {
		closeSheet();
		return;
	}
	send({ t: "ui", id: dialog.id, cancelled: true });
	closeSheet();
}

// ------------------------------------------------------- tree sheet (08)

const TREE_ROLE = {
	user: "you",
	assistant: "pi",
	toolResult: "tool",
	bashExecution: "bash",
	compaction: "compaction",
	branch_summary: "branch summary",
};

/**
 * Read-only session tree from RPC `get_tree`. Indentation follows the nesting,
 * the current branch is marked, and user entries get the two actions the TUI
 * offers: fork from here, copy the prompt. Leaf navigation is deliberately
 * absent (RPC exposes no navigate command).
 */
function openTreeSheet(tree, leafId) {
	const rows = flattenTree(tree, leafId);
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(`tree${rows.length ? ` · ${rows.length} entries` : ""}`);
	target.append(heading);

	const list = document.createElement("div");
	list.className = "tree";
	if (rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "sheet-text";
		empty.textContent = "no entries yet";
		list.append(empty);
	}
	for (const row of rows) {
		const item = document.createElement("div");
		item.className = `tree-row${row.current ? " current" : ""}${row.leaf ? " leaf" : ""}`;
		item.style.paddingLeft = `${8 + row.depth * 14}px`;

		const head = document.createElement("div");
		head.className = "tree-head";
		const role = document.createElement("span");
		role.className = `tree-role ${row.user ? "user" : ""}`;
		role.textContent = TREE_ROLE[row.role] ?? row.role;
		head.append(role);
		if (row.label) {
			const label = document.createElement("span");
			label.className = "tree-label";
			label.textContent = row.label;
			head.append(label);
		}
		if (row.leaf) {
			const current = document.createElement("span");
			current.className = "tree-current";
			current.textContent = "current";
			head.append(current);
		}
		item.append(head);

		if (row.text) {
			const text = document.createElement("div");
			text.className = "tree-text";
			text.textContent = row.text;
			item.append(text);
		}
		if (row.user && row.id) {
			const actions = document.createElement("div");
			actions.className = "tree-actions";
			const fork = document.createElement("button");
			fork.type = "button";
			fork.className = "tree-action";
			fork.textContent = "fork from here";
			fork.addEventListener("click", () => {
				closeSheet();
				send({ t: "fork", entryId: row.id });
			});
			const copy = document.createElement("button");
			copy.type = "button";
			copy.className = "tree-action";
			copy.textContent = "copy prompt";
			copy.addEventListener("click", () => {
				closeSheet();
				void copyText(row.text);
			});
			actions.append(fork, copy);
			item.append(actions);
		}
		list.append(item);
	}
	target.append(list);

	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(close);
	target.append(actions);
}

/** `/export`: the HTML and (when the session file exists) the JSONL as downloads. */
function openExportSheet(html, jsonl) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("export");
	const note = document.createElement("div");
	note.className = "sheet-text";
	note.textContent = "downloads only · nothing is sent to the model";
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	for (const [label, url] of [["download HTML", html], ["download JSONL", jsonl]]) {
		if (!url) continue;
		const link = document.createElement("a");
		link.className = "sheet-download";
		link.href = url;
		link.setAttribute("download", "");
		link.textContent = label;
		actions.append(link);
	}
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(close);
	target.append(heading, note, actions);
}

// --------------------------------------------------------------- ui dialogs

function handleUiRequest(request) {
	const method = request.method;
	if (method === "notify") {
		notice(request.message ?? "");
		return;
	}
	if (applyAddonUi(state.addon, request)) {
		renderFooter();
		return;
	}
	if (!["select", "confirm", "input", "editor"].includes(method)) return;
	state.uiDialog = request;
	const sheet = ui.sheet;
	sheet.hidden = false;
	sheet.textContent = "";
	const actions = document.createElement("div");
	actions.className = "sheet-actions";

	const finish = (fields) => {
		if (state.uiDialog?.id !== request.id) return;
		send({ t: "ui", id: request.id, ...fields });
		closeSheet();
	};

	const addButton = (label, fields, className = "") => {
		const button = document.createElement("button");
		button.textContent = label;
		if (className) button.classList.add(className);
		const resolveFields = typeof fields === "function" ? fields : () => fields;
		button.addEventListener("click", () => finish(resolveFields()));
		actions.append(button);
	};

	if (method === "select") {
		sheet.append(sheetHeader(request.title ?? request.message ?? method));
		for (const option of request.options ?? []) addButton(String(option), { value: option });
	} else if (method === "confirm") {
		sheet.append(sheetHeader(request.title ?? request.message ?? method));
		addButton(request.yesLabel ?? "yes", { confirmed: true }, "primary");
		addButton(request.noLabel ?? "no", { confirmed: false });
	} else {
		sheet.append(sheetCloseRow());
		const field = document.createElement(method === "editor" ? "textarea" : "input");
		if (method === "editor") field.rows = 6;
		field.value = request.value ?? request.initialValue ?? request.prefill ?? "";
		sheet.append(field);
		const hint = document.createElement("div");
		hint.className = "sheet-hint";
		hint.textContent = request.title ?? request.message ?? method;
		sheet.append(hint);
		field.focus();
		addButton("send", () => ({ value: field.value }), "primary");
		field.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				finish({ value: field.value });
			}
		});
	}
	addButton("cancel", { cancelled: true });
	sheet.append(actions);
}

// ------------------------------------------------------------------ composer

/** pixip built-in handlers; the classifier in commands.js decides who gets here. */
const builtinHandlers = {
	compact(args) {
		send({ t: "compact", ...(args ? { instructions: args } : {}) });
	},
	name(args) {
		if (!args) {
			toast(`name: ${state.info?.name || "(unnamed)"}`);
			return;
		}
		send({ t: "set_session_name", name: args });
	},
	session() {
		textSheet("session", formatSession(state.info, state.footer));
	},
	copy() {
		send({ t: "copy" });
	},
	model(args) {
		if (!args) {
			send({ t: "models" });
			return;
		}
		send({ t: "set_model_query", query: args });
	},
	thinking(args) {
		if (!args) {
			send({ t: "thinking" });
			return;
		}
		send({ t: "set_thinking_query", query: args });
	},
	"new"() {
		send({ t: "new_session" });
	},
	resume() {
		location.hash = "";
	},
	quit() {
		quitSession();
	},
	tree() {
		send({ t: "tree" });
	},
	fork(args) {
		// With an id the fork runs directly; bare `/fork` opens the tree sheet to
		// pick a user message (the TUI picker).
		if (args) {
			send({ t: "fork", entryId: args });
			return;
		}
		send({ t: "tree" });
	},
	clone() {
		send({ t: "clone" });
	},
	import(args) {
		if (!args) {
			toast("usage: /import <path>");
			return;
		}
		send({ t: "import", path: args });
	},
	export() {
		send({ t: "export" });
	},
};

function clearInput() {
	ui.input.value = "";
	closeMenu();
	resize();
}

function submit() {
	const text = ui.input.value.trim();
	if (!text) return;
	const action = classifyInput(text);
	switch (action.kind) {
		case "empty":
			return;
		case "menu":
			// `/` opens the suggestion menu in 06-command-menu; keep the text until then.
			return;
		case "bash":
			submitBash(action);
			return;
		case "tui":
			if (!allowed(action)) return;
			notice(
				`/${action.name} is a Pi TUI-only command${action.command?.ticket ? ` (planned in ${action.command.ticket})` : ""} — use a terminal`,
			);
			clearInput();
			return;
		case "builtin": {
			if (!allowed(action)) return;
			const handler = builtinHandlers[action.name];
			if (!handler) {
				notice(`/${action.name} is not wired yet`);
				clearInput();
				return;
			}
			handler(action.args);
			clearInput();
			return;
		}
		case "passthrough":
			// Unknown `/thing` and every extension command/template/skill go to Pi
			// verbatim. While busy that must be `prompt` + steer: RPC `steer` would
			// queue the text instead of executing the extension command.
			if (!allowed(action)) return;
			submitSlash(action.text);
			return;
		default:
			submitText(action.text);
	}
}

/** Replacement snapshot: a compaction or a `/new` invalidates loaded windows. */
function renderReplace(entries, more) {
	state.entries = [];
	state.more = false;
	state.stick = true;
	renderSnapshot(entries, more);
}

function applyPolicy(policy) {
	state.policy = policy && typeof policy === "object"
		? {
				allow: Array.isArray(policy.allow) ? policy.allow.filter((name) => typeof name === "string") : [],
				deny: Array.isArray(policy.deny) ? policy.deny.filter((name) => typeof name === "string") : [],
				bash: policy.bash !== false,
			}
		: null;
}

/** Denied commands never reach the model; they get a local notice instead. */
function allowed(action) {
	if (isAllowed(action.name, state.policy)) return true;
	notice(`/${action.name} is blocked by the command policy`);
	clearInput();
	return false;
}

/** Soft quit: stop/detach the child, then return to the list. */
function quitSession() {
	send({ t: "stop" });
	state.quitting = true;
	// The status frame normally navigates; this is the fallback if the socket
	// drops before it arrives.
	setTimeout(() => {
		if (!state.quitting) return;
		state.quitting = false;
		location.hash = "";
	}, 500);
}

/** `/copy`: the hub supplies Pi's last assistant text; clipboard may be absent. */
async function copyText(text) {
	if (typeof text !== "string" || !text.trim()) {
		toast("nothing to copy");
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		toast("copied");
	} catch {
		copySheet(text);
	}
}

function copySheet(text) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("copy");
	const body = document.createElement("pre");
	body.className = "sheet-text";
	body.textContent = text;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const copy = document.createElement("button");
	copy.textContent = "copy";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			toast("copied");
			closeSheet();
		} catch {
			toast("copy failed — select the text and copy manually");
		}
	});
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(copy, close);
	target.append(heading, body, actions);
}

function submitSlash(text) {
	const busy = state.info?.state === "busy";
	send({ t: "prompt", text, ...(busy ? { streamingBehavior: "steer" } : {}) });
	// No optimistic user echo: an extension command may consume the prompt, and
	// Pi's own message_start paints templates/skills when they produce a message.
	clearInput();
}

function submitText(text) {
	const busy = state.info?.state === "busy";
	send({ t: busy ? "steer" : "prompt", text });
	state.pendingUser = appendBlock("user", `<div class="who">you</div><div class="text">${escapeHtml(text)}</div>`, true);
	clearInput();
	scrollToEnd(true);
}

let bashSeq = 0;

function submitBash(action) {
	// `!`/`!!` with no command is a no-op (the TUI keeps the text for editing).
	if (!action.command) return;
	if (state.policy && state.policy.bash === false) {
		notice("bash is disabled by the command policy");
		clearInput();
		return;
	}
	if (state.bashRunning) {
		// TUI guard: one bash at a time; keep the text so it can be resubmitted.
		toast("a bash command is already running");
		return;
	}
	const id = `b${++bashSeq}-${Date.now().toString(36)}`;
	state.bashRunning = true;
	state.bash.set(id, appendBashCard(id, action.command, action.excludeFromContext));
	send({ t: "bash", id, command: action.command, excludeFromContext: action.excludeFromContext });
	clearInput();
	scrollToEnd(true);
}

/** Optimistic card on submit: the TUI shows only the bash card, never a user echo. */
function appendBashCard(id, command, excluded) {
	const host = document.createElement("div");
	host.innerHTML = bashCardHtml({
		command,
		output: "",
		exitCode: null,
		cancelled: false,
		truncated: false,
		excludeFromContext: excluded,
		running: true,
	});
	const card = host.firstElementChild;
	if (!card) return ui.log.appendChild(document.createElement("div"));
	card.dataset.bash = id;
	ui.log.append(card);
	scheduleScroll();
	return card;
}

/** Final `bash` frame: replace the streamed card with the authoritative result. */
function finishBash(frame) {
	state.bashRunning = false;
	const card = state.bash.get(frame.id);
	state.bash.delete(frame.id);
	if (!card) {
		if (frame.error) toast(frame.error);
		return;
	}
	if (frame.error) {
		card.classList.remove("running");
		card.classList.add("error");
		const meta = card.querySelector(".bash-meta");
		if (meta) meta.textContent = `failed: ${frame.error}`;
		scrollToEnd();
		return;
	}
	card.insertAdjacentHTML("beforebegin", bashCardHtml(frame));
	card.remove();
	scrollToEnd();
}

ui.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	submit();
});

ui.input.addEventListener("keydown", (event) => {
	if (!ui.menu.hidden) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveMenu(event.key === "ArrowDown" ? 1 : -1);
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			chooseMenu(state.menu.index);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey && !state.coarse) {
		event.preventDefault();
		submit();
	}
});
ui.input.addEventListener("input", () => {
	resize();
	renderMenu();
});
ui.input.addEventListener("focus", renderMenu);
ui.input.addEventListener("blur", () => closeMenu());

// ------------------------------------------------------------- command menu

/**
 * The `/` menu (06): open only while the line is a bare command, filtered
 * prefix-first, capped and scrollable in CSS. `↑`/`↓` move, `Enter`/`Tab`
 * insert, `Esc` closes, a tap inserts (pointerdown keeps the input focused).
 */
function renderMenu() {
	const query = commandQuery(ui.input.value);
	if (query === null || document.activeElement !== ui.input) {
		closeMenu();
		return;
	}
	const items = filterCommands(menuCatalog(state.policy, state.dynamicCommands), query);
	state.menu.items = items;
	if (state.menu.index >= items.length) state.menu.index = 0;
	if (items.length === 0) {
		closeMenu();
		return;
	}
	ui.menu.textContent = "";
	items.forEach((item, index) => {
		const row = document.createElement("button");
		row.type = "button";
		row.className = `menu-row${item.tuiOnly ? " tui" : ""}${index === state.menu.index ? " active" : ""}`;
		row.dataset.index = String(index);
		row.setAttribute("role", "option");
		row.setAttribute("aria-selected", index === state.menu.index ? "true" : "false");
		const name = document.createElement("span");
		name.className = "menu-name";
		name.textContent = `/${item.name}`;
		row.append(name);
		if (item.args) {
			const args = document.createElement("span");
			args.className = "menu-args";
			args.textContent = item.args;
			row.append(args);
		}
		if (item.summary) {
			const summary = document.createElement("span");
			summary.className = "menu-summary";
			summary.textContent = item.summary;
			row.append(summary);
		}
		if (item.tuiOnly) {
			const hint = document.createElement("span");
			hint.className = "menu-hint";
			hint.textContent = "TUI-only";
			row.append(hint);
		}
		ui.menu.append(row);
	});
	ui.menu.hidden = false;
	scheduleScroll();
}

function closeMenu() {
	const wasOpen = !ui.menu.hidden;
	ui.menu.hidden = true;
	state.menu.items = [];
	state.menu.index = 0;
	if (!wasOpen) return;
	ui.menu.textContent = "";
	scheduleScroll();
}

function moveMenu(delta) {
	const count = state.menu.items.length;
	if (count === 0) return;
	state.menu.index = (state.menu.index + delta + count) % count;
	for (const [index, row] of [...ui.menu.children].entries()) {
		row.classList.toggle("active", index === state.menu.index);
		row.setAttribute("aria-selected", index === state.menu.index ? "true" : "false");
	}
	ui.menu.children[state.menu.index]?.scrollIntoView({ block: "nearest" });
}

/** Insert the selection; a TUI-only command runs its notice immediately. */
function chooseMenu(index) {
	const item = state.menu.items[index];
	if (!item) return;
	closeMenu();
	if (item.tuiOnly) {
		ui.input.value = `/${item.name}`;
		submit();
		return;
	}
	ui.input.value = menuInsertText(item);
	resize();
	ui.input.focus();
	ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length);
}

ui.menu.addEventListener("pointerdown", (event) => {
	const row = event.target.closest(".menu-row");
	if (!row) return;
	// Keep the textarea focused; the tap is the selection, not a blur.
	event.preventDefault();
	chooseMenu(Number(row.dataset.index));
});

// --------------------------------------------------------------- queue chips

/**
 * Pending steering/follow-up chips above the composer (07). Pi's `queue_update`
 * carries the whole queue, so this replaces the chips; the only action is the
 * X, which clears both lists and restores the texts into the composer.
 */
function renderQueue() {
	const queue = state.queue;
	const count = queueCount(queue);
	if (count === 0) {
		if (ui.queue.hidden) return;
		ui.queue.hidden = true;
		ui.queue.textContent = "";
		scheduleScroll();
		return;
	}
	ui.queue.textContent = "";
	const head = document.createElement("div");
	head.className = "queue-head";
	const label = document.createElement("span");
	label.className = "queue-label";
	label.textContent = `${count} queued`;
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "queue-clear";
	clear.setAttribute("aria-label", "Clear queued messages");
	clear.title = "clear and restore to the composer";
	clear.textContent = "×";
	clear.addEventListener("click", () => send({ t: "clear_queue" }));
	head.append(label, clear);

	const chips = document.createElement("div");
	chips.className = "queue-chips";
	for (const text of queueTexts(queue)) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "queue-chip";
		chip.textContent = text;
		chip.title = "tap to expand";
		chip.addEventListener("click", () => chip.classList.toggle("expanded"));
		chips.append(chip);
	}
	ui.queue.append(head, chips);
	ui.queue.hidden = false;
	scheduleScroll();
}

/** `clear_queue` answer: chips go away, texts return to the composer unsent. */
function restoreClearedQueue(frame) {
	const cleared = queueFromEvent(frame);
	state.queue = { steering: [], followUp: [] };
	renderQueue();
	const count = queueCount(cleared);
	const text = restoreText(cleared, ui.input.value);
	if (count > 0 && text !== ui.input.value) {
		ui.input.value = text;
		resize();
		ui.input.focus();
		ui.input.setSelectionRange(text.length, text.length);
	}
	toast(count > 0 ? `restored ${count} queued message${count === 1 ? "" : "s"}` : "queue already empty");
	scheduleScroll();
}

function resize() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

// ------------------------------------------------------------- transcript size

function readScale() {
	try {
		return parseStored(localStorage.getItem(STORAGE_KEY));
	} catch {
		// Storage can throw in private modes / blocked-cookie contexts.
		return DEFAULT_PERCENT;
	}
}

function saveScale(percent) {
	try {
		localStorage.setItem(STORAGE_KEY, String(percent));
	} catch {}
}

/**
 * Apply a transcript size, keeping the reading position: a pinned view stays
 * pinned, otherwise the distance from the bottom is held. Only `#log`'s font
 * size changes, so the composer does not move.
 */
function setScale(percent, { persist = true } = {}) {
	const next = clampPercent(percent);
	if (next !== state.scale) {
		const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
		state.scale = next;
		document.documentElement.style.setProperty("--transcript-scale", String(scaleFactor(next)));
		ui.log.scrollTop = Math.max(0, ui.log.scrollHeight - distance);
	}
	if (persist) saveScale(next);
	updateScaleButtons();
}

function updateScaleButtons() {
	ui.scaleDown.disabled = state.scale === STEPS[0];
	ui.scaleUp.disabled = state.scale === STEPS[STEPS.length - 1];
	ui.scaleDown.setAttribute("aria-label", decreaseLabel(state.scale));
	ui.scaleUp.setAttribute("aria-label", increaseLabel(state.scale));
	ui.scaleValue.textContent = `${state.scale}%`;
	ui.scaleValue.title = `Transcript text size: ${state.scale}%`;
}

/** Tap steps; a long-press resets to 100 % without also firing the click. */
function bindScaleButton(button, step) {
	let timer = 0;
	let longPressed = false;
	const cancel = () => {
		clearTimeout(timer);
		timer = 0;
	};
	button.addEventListener("pointerdown", () => {
		cancel();
		longPressed = false;
		timer = setTimeout(() => {
			longPressed = true;
			timer = 0;
			setScale(DEFAULT_PERCENT);
		}, 550);
	});
	for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
		button.addEventListener(type, cancel);
	}
	button.addEventListener("contextmenu", (event) => event.preventDefault());
	button.addEventListener("click", () => {
		if (longPressed) {
			longPressed = false;
			return;
		}
		setScale(step === "up" ? nextPercent(state.scale) : previousPercent(state.scale));
	});
}

bindScaleButton(ui.scaleDown, "down");
bindScaleButton(ui.scaleUp, "up");
setScale(readScale(), { persist: false });

// Escape is the keyboard half of the modal x: cancel Pi's dialog once, or
// close a local sheet. Backdrop clicks deliberately do nothing.
window.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || ui.sheet.hidden) return;
	event.preventDefault();
	dismissSheet();
});

// Desktop shortcuts. `Ctrl/Cmd` is intentional rather than plain `-`/`+` so
// typing in the composer is never affected; browser zoom still compounds.
window.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
	if (event.key === "-" || event.key === "_") {
		event.preventDefault();
		setScale(previousPercent(state.scale));
	} else if (event.key === "+" || event.key === "=") {
		event.preventDefault();
		setScale(nextPercent(state.scale));
	} else if (event.key === "0") {
		event.preventDefault();
		setScale(DEFAULT_PERCENT);
	}
});

ui.back.addEventListener("click", () => {
	location.hash = "";
});
ui.stop.addEventListener("click", () => {
	send({ t: "stop" });
});

/**
 * Soft refresh, then a full page reload. The hub re-reads assets, policy and the
 * session index without touching live children; the page reload reconnects with
 * the durable cursor. A hard restart is a CLI action (`pixip restart`), not a
 * button: it ends the in-flight turn.
 */
async function softRefresh() {
	ui.reload.disabled = true;
	try {
		const response = await fetch("/api/refresh", { method: "POST" });
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error ?? `refresh failed (${response.status})`);
		location.reload();
	} catch (error) {
		ui.reload.disabled = false;
		toast(`reload failed: ${error.message}`);
	}
}

ui.reload.addEventListener("click", () => void softRefresh());
ui.settings.addEventListener("click", openSettingsSheet);

window.addEventListener("hashchange", route);

// ----------------------------------------------------------------- plumbing

function appendBlock(kind, html, raw = false) {
	const section = document.createElement(kind ? "section" : "div");
	if (kind) section.className = `block ${kind}`;
	if (raw) section.innerHTML = html;
	else section.textContent = html;
	ui.log.append(section);
	scheduleScroll();
	return section;
}

function setBusy(busy) {
	if (state.info) {
		state.info.state = busy ? "busy" : "idle";
		applyInfo();
	}
}

function scrollToEnd(force = false) {
	if (force) state.stick = true;
	scheduleScroll();
}

let scrollQueued = false;
function scheduleScroll() {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		if (!state.stick) return;
		ui.log.scrollTop = ui.log.scrollHeight;
	});
}

ui.log.addEventListener("scroll", () => {
	const distance = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight;
	state.stick = distance < 80;
});

/** The small "fork" affordance on user blocks (08) is delegated: the transcript
 *  is repainted in chunks, so per-button listeners would be lost. */
ui.log.addEventListener("click", (event) => {
	const button = event.target.closest("[data-fork]");
	if (!button) return;
	const entryId = button.dataset.fork;
	if (entryId) send({ t: "fork", entryId });
});

let toastTimer;
function toast(message) {
	if (!message) return;
	ui.toast.textContent = message;
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, 3200);
}

/** Toast with one action (delete undo); stays up long enough to be reachable. */
function actionToast(message, label, action, ms = 10_000) {
	if (!message) return;
	ui.toast.textContent = "";
	const text = document.createElement("span");
	text.textContent = message;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "toast-action";
	button.textContent = label;
	button.addEventListener("click", () => {
		clearTimeout(toastTimer);
		ui.toast.hidden = true;
		void action();
	});
	ui.toast.append(text, button);
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, ms);
}

/** A 3.2 s toast is useless for `/fit help`'s 2 KB notify: long or multi-line
 *  notices get a dismissible sheet instead. */
const NOTICE_SHEET_CHARS = 180;
function notice(message) {
	if (!message) return;
	if (message.includes("\n") || message.length > NOTICE_SHEET_CHARS) {
		textSheet("notice", message);
		return;
	}
	toast(message);
}

function textSheet(title, text) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(title);
	const body = document.createElement("pre");
	body.className = "sheet-text";
	body.textContent = text;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(close);
	target.append(heading, body, actions);
}

route();

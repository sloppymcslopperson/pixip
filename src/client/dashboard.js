// Client dashboard module; shared state and transport live in app.js.
import {
	COLLAPSED_STORAGE_KEY,
	KEEP_ACTIVE_STORAGE_KEY,
	actionToast,
	beginNewSession,
	cacheCurrentSession,
	clearPendingAttachment,
	closeMenu,
	closeSheet,
	connect,
	countLabel,
	createAddonUi,
	crumbTrail,
	escapeHtml,
	filterDirEntries,
	forgetCachedSession,
	groupBranch,
	groupLabel,
	groupSessions,
	groupView,
	initialDirectory,
	parentDirectory,
	parseCollapsed,
	parseKeepActive,
	relativeTime,
	renderQueue,
	resetSurface,
	serializeCollapsed,
	serializeKeepActive,
	sheet,
	sheetHeader,
	state,
	toast,
	ui,
} from "./app.js";

export async function showList() {
	cacheCurrentSession();
	state.sessionId = null;
	ui.jump.hidden = true;
	state.info = null;
	state.pendingCreate = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	clearPendingAttachment();
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
	resetSurface();
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

export async function listSessions() {
	try {
		return await (await fetch("/api/sessions")).json();
	} catch {
		return [];
	}
}

export async function apiJson(path, options = {}) {
	const response = await fetch(path, options);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
	return body;
}

export async function refreshDashboard() {
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}

export function renderList(sessions, defaultCwd = state.defaultCwd, home = state.home) {
	// A list refresh (or a local toggling re-render) must not discard a path the
	// user is typing into the new-session form.
	const draft = ui.list.querySelector("#new-row input")?.value;
	state.sessions = Array.isArray(sessions) ? sessions : [];
	if (typeof defaultCwd === "string") state.defaultCwd = defaultCwd;
	if (typeof home === "string") state.home = home;
	ui.list.textContent = "";
	const form = document.createElement("form");
	form.id = "new-row";
	const value = draft !== undefined ? draft : (state.defaultCwd ?? "");
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

export const picker = {
	path: "",
	listing: null,
	filter: "",
	notice: "",
	loading: false,
	token: 0,
};

export let pickerUi = null;

export function setNewCwd(path) {
	const input = ui.list.querySelector("#new-row input");
	if (!input) return;
	input.value = path;
	input.focus();
}

export async function openDirectorySheet(startPath) {
	picker.filter = "";
	picker.notice = "";
	picker.listing = null;
	await loadDirectory(startPath, true);
}

export async function loadDirectory(path, resetFilter = false) {
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

export function renderDirectorySheet() {
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

export function dirMessage(text) {
	const row = document.createElement("div");
	row.className = "dir-empty";
	row.textContent = text;
	return row;
}

export function dirButton(label, path, repo, title) {
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

export function updateDirectoryList() {
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

export function showNewFolderForm() {
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

export async function createPickerFolder(name) {
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

export function renderGroup(group) {
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
		add.addEventListener("click", () => beginNewSession(group.cwd));
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

export function sessionRow(session) {
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

export function openSessionActions(session) {
	const label = session.name ?? session.id.slice(0, 8);
	sheet(`session · ${label}`, [
		["archive", () => confirmSessionAction("archive", session)],
		["delete", () => confirmSessionAction("delete", session)],
	]);
}

export function confirmSessionAction(kind, session) {
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

export function confirmSheet(title, message, confirmLabel, action) {
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

export async function archiveSession(session) {
	try {
		await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
		forgetCachedSession(session);
		await refreshDashboard();
		toast("archived");
	} catch (error) {
		toast(`archive failed: ${error.message}`);
	}
}

export async function deleteSession(session) {
	try {
		const result = await apiJson(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
		forgetCachedSession(session);
		await refreshDashboard();
		const token = result?.undo?.token;
		if (token) {
			actionToast(
				`deleted ${session.name ?? session.id.slice(0, 8)}`,
				"undo",
				async () => {
					try {
						await apiJson(`/api/trash/${encodeURIComponent(token)}/restore`, { method: "POST" });
						await refreshDashboard();
						toast("restored");
					} catch (error) {
						toast(`restore failed: ${error.message}`);
					}
				},
				10_000,
			);
		} else {
			toast("deleted");
		}
	} catch (error) {
		toast(`delete failed: ${error.message}`);
	}
}

export async function archiveInactive(count) {
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

export function readCollapsedGroups() {
	try {
		return parseCollapsed(localStorage.getItem(COLLAPSED_STORAGE_KEY));
	} catch {
		return {};
	}
}

export function saveCollapsedGroups() {
	try {
		localStorage.setItem(COLLAPSED_STORAGE_KEY, serializeCollapsed(state.collapsed));
	} catch {}
}

export function readKeepActive() {
	try {
		return parseKeepActive(localStorage.getItem(KEEP_ACTIVE_STORAGE_KEY));
	} catch {
		return true;
	}
}

export function saveKeepActive() {
	try {
		localStorage.setItem(KEEP_ACTIVE_STORAGE_KEY, serializeKeepActive(state.keepActive));
	} catch {}
}

export async function openSettingsSheet() {
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

export async function showStoredSheet(kind) {
	const archived = kind === "archive";
	try {
		const items = await apiJson(archived ? "/api/archived" : "/api/trash");
		renderStoredSheet(kind, Array.isArray(items) ? items : []);
	} catch (error) {
		toast(`load failed: ${error.message}`);
	}
}

export function renderStoredSheet(kind, items) {
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

export async function restoreStored(kind, item) {
	const id = item.logicalId ?? item.id;
	try {
		await apiJson(`/api/${kind === "archive" ? "archived" : "trash"}/${encodeURIComponent(id)}/restore`, {
			method: "POST",
		});
		await refreshDashboard();
		toast("restored");
		await showStoredSheet(kind);
	} catch (error) {
		toast(`restore failed: ${error.message}`);
	}
}

export async function purgeStored(kind, item) {
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

// Dashboard session list and cwd groups. Pure display predicates are exported
// for Node tests; the DOM builders stay event-driven and thin.
import { initialDirectory } from "./directoryPicker.js";
import { listSessions } from "./dashboardApi.js";
import { archiveInactive, openSessionActions } from "./dashboardSettings.js";
import { openDirectorySheet } from "./dashboardPicker.js";
import { draftInputValue, groupDisplay, inactiveSessions } from "./dashboardModel.js";
import { beginNewSession } from "./navigation.js";
import { escapeHtml, relativeTime } from "./render.js";
import {
	COLLAPSED_STORAGE_KEY,
	countLabel,
	groupBranch,
	groupLabel,
	groupSessions,
	serializeCollapsed,
} from "./sessionGroups.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export async function refreshDashboard() {
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}

export function renderList(sessions, defaultCwd = state.defaultCwd, home = state.home) {
	const draft = ui.list.querySelector("#new-row input")?.value;
	state.sessions = Array.isArray(sessions) ? sessions : [];
	if (typeof defaultCwd === "string") state.defaultCwd = defaultCwd;
	if (typeof home === "string") state.home = home;
	ui.list.textContent = "";
	const form = document.createElement("form");
	form.id = "new-row";
	const value = draftInputValue(draft, state.defaultCwd);
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

	const inactive = inactiveSessions(state.sessions);
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

export function renderGroup(group) {
	const section = document.createElement("section");
	section.className = "group";
	section.dataset.cwd = group.key;
	// Open states persist; a group seen for the first time starts collapsed.
	const collapsed = state.collapsed[group.key] !== false;
	const { view, canToggle } = groupDisplay(group, collapsed, state.keepActive);
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

export function saveCollapsedGroups() {
	try {
		localStorage.setItem(COLLAPSED_STORAGE_KEY, serializeCollapsed(state.collapsed));
	} catch {}
}

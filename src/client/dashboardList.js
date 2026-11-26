// Dashboard session list and cwd groups. Pure display predicates are exported
// for Node tests; the DOM builders stay event-driven and thin.
import { initialDirectory } from "./directoryPicker.js";
import { installDeps } from "./configure.js";
import { listSessions } from "./dashboardApi.js";
import { openDirectorySheet } from "./dashboardPicker.js";
import { openNewWorktreeSheet, openWorktreeSheet } from "./dashboardWorktree.js";
import { bulkArchiveTargets, draftInputValue, groupDisplay } from "./dashboardModel.js";
import { beginNewSession } from "./navigation.js";
import { escapeHtml, relativeTime } from "./render.js";
import { displayState } from "./sessionInfo.js";
import {
	COLLAPSED_STORAGE_KEY,
	countLabel,
	groupActions,
	groupBranch,
	groupLabel,
	groupSessionCount,
	groupSessionTree,
	serializeCollapsed,
	worktreeBranchLabel,
} from "./sessionGroups.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureDashboardList(next) {
	deps = installDeps("dashboardList", "configureDashboardList", next, ["archiveInactive", "openSessionActions"]);
}

export async function refreshDashboard() {
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}

export function renderList(sessions, defaultCwd = state.defaultCwd, home = state.home) {
	closeGroupMenu();
	const draft = ui.list.querySelector("#new-row input")?.value;
	state.sessions = Array.isArray(sessions) ? sessions : [];
	if (typeof defaultCwd === "string") state.defaultCwd = defaultCwd;
	if (typeof home === "string") state.home = home;
	ui.list.textContent = "";
	const form = document.createElement("form");
	form.id = "new-row";
	const value = draftInputValue(draft, state.defaultCwd);
	form.innerHTML = `<input name="cwd" value="${escapeHtml(value)}" placeholder="/path/to/project" autocapitalize="off" autocorrect="off" spellcheck="false" /><button type="button" class="browse">browse</button><button type="submit" class="new-plain">new</button><button type="submit" class="new-worktree">new with worktree</button>`;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const cwd = form.querySelector("input")?.value?.trim();
		if (!cwd) return;
		if (event.submitter?.classList.contains("new-worktree")) void openNewWorktreeSheet(cwd);
		else beginNewSession(cwd);
	});
	form.querySelector(".browse")?.addEventListener("click", () => {
		void openDirectorySheet(initialDirectory(state.defaultCwd, state.home));
	});
	ui.list.append(form);

	const targets = bulkArchiveTargets(state.sessions);
	if (targets.length > 0) {
		const bulk = document.createElement("button");
		bulk.type = "button";
		bulk.className = "bulk-archive";
		bulk.textContent = `archive inactive (${targets.length})`;
		bulk.title = "Archive stopped sessions, keeping the newest in a group with no active sessions";
		bulk.addEventListener("click", () => void deps.archiveInactive(targets));
		ui.list.append(bulk);
	}

	const groups = groupSessionTree(state.sessions);
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
	section.className = group.kind === "worktree" ? "group worktree-group" : "group";
	section.dataset.cwd = group.cwd;
	// Open states persist; a group seen for the first time starts collapsed.
	const collapsed = state.collapsed[group.key] !== false;
	const display = groupDisplay({ sessions: group.sessions }, collapsed, state.keepActive);
	const view = display.view;
	const hidden = groupSessionCount(group) - view.rows.length;
	const canToggle = group.kind === "repo" ? hidden > 0 : display.canToggle;
	const head = document.createElement("div");
	head.className = "group-head";
	const control = makeGroupControl(group, collapsed, canToggle, hidden);
	head.append(control);
	if (group.kind === "plain") {
		const add = document.createElement("button");
		add.type = "button";
		add.className = "group-new";
		add.textContent = "+";
		add.title = "new session here";
		add.setAttribute("aria-label", `New session in ${groupLabel(group, state.home)}`);
		add.addEventListener("click", () => beginNewSession(group.cwd));
		head.append(add);
	} else {
		const add = document.createElement("button");
		add.type = "button";
		add.className = "group-new";
		add.textContent = "+";
		add.title = "session actions";
		add.setAttribute("aria-label", `Actions for ${groupLabel(group, state.home)}`);
		add.setAttribute("aria-haspopup", "menu");
		add.addEventListener("click", (event) => {
			event.stopPropagation();
			openGroupMenu(head, group);
		});
		head.append(add);
	}
	section.append(head);
	if (view.rows.length > 0) {
		const rows = document.createElement("div");
		rows.className = "group-rows";
		for (const session of view.rows) rows.append(sessionRow(session));
		section.append(rows);
	}
	if (!collapsed && group.kind === "repo") {
		for (const child of group.worktrees) section.append(renderGroup(child));
	}
	return section;
}

function makeGroupControl(group, collapsed, canToggle, hidden) {
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
	path.title = group.cwd || "unknown cwd";
	const branch =
		group.kind === "worktree" ? worktreeBranchLabel(group.branch) : group.kind === "repo" ? groupBranch(group) : "";
	const count = document.createElement("span");
	count.className = "group-count";
	count.textContent = countLabel(groupSessionCount(group), hidden);
	control.append(path);
	if (branch) {
		const chip = document.createElement("span");
		chip.className = "group-branch";
		chip.textContent = branch;
		chip.title = `git branch ${group.kind === "worktree" ? group.branch : branch}`;
		control.append(chip);
	}
	control.append(count);
	return control;
}

let groupMenu = null;

function closeGroupMenu() {
	groupMenu?.remove();
	groupMenu = null;
	document.removeEventListener("click", onDocumentClick, true);
}

function onDocumentClick(event) {
	if (groupMenu?.contains(event.target)) return;
	closeGroupMenu();
}

function openGroupMenu(head, group) {
	closeGroupMenu();
	const menu = document.createElement("div");
	menu.className = "group-menu";
	menu.setAttribute("role", "menu");
	for (const action of groupActions(group)) {
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("role", "menuitem");
		if (action === "newWorktree") {
			button.textContent = "new with worktree";
			button.addEventListener("click", () => {
				closeGroupMenu();
				void openNewWorktreeSheet(group.repo ?? group.cwd);
			});
		} else if (action === "delete") {
			button.textContent = "delete worktree";
			button.className = "danger";
			button.addEventListener("click", () => {
				closeGroupMenu();
				void openWorktreeSheet(group);
			});
		} else {
			button.textContent = "new session";
			button.addEventListener("click", () => {
				closeGroupMenu();
				beginNewSession(group.cwd);
			});
		}
		menu.append(button);
	}
	head.append(menu);
	groupMenu = menu;
	// Defer so the opening click does not immediately close the menu.
	setTimeout(() => document.addEventListener("click", onDocumentClick, true), 0);
}

export function sessionRow(session) {
	const row = document.createElement("div");
	row.className = "row";
	row.dataset.id = session.id;
	const open = document.createElement("button");
	open.type = "button";
	open.className = "row-open";
	const stateClass = escapeHtml(displayState(session));
	const protectedMark = session.protected
		? '<span class="row-protected" title="protected from bulk archive" aria-label="protected from bulk archive">●</span>'
		: "";
	open.innerHTML = `<div class="row-top"><span class="dot ${stateClass}"></span>${protectedMark}<span class="row-name">${escapeHtml(session.name ?? session.id.slice(0, 8))}</span><span class="row-state">${stateClass} · ${relativeTime(session.lastActivity)}</span></div>`;
	open.addEventListener("click", () => {
		location.hash = `s=${encodeURIComponent(session.id)}`;
	});
	const actions = document.createElement("button");
	actions.type = "button";
	actions.className = "row-actions";
	actions.textContent = "⋯";
	actions.title = "Session actions";
	actions.setAttribute("aria-label", `Actions for ${session.name ?? session.id.slice(0, 8)}`);
	actions.addEventListener("click", () => deps.openSessionActions(session));
	row.append(open, actions);
	return row;
}

export function saveCollapsedGroups() {
	try {
		localStorage.setItem(COLLAPSED_STORAGE_KEY, serializeCollapsed(state.collapsed));
	} catch {}
}

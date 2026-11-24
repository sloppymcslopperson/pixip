// Worktree management sheet: list, delete confirmation and the safe refusal
// states. HTTP stays in dashboardApi; path/slug math stays in sessionGroups.
import { apiJson } from "./dashboardApi.js";
import { installDeps } from "./configure.js";
import { beginNewSession, openSession } from "./navigation.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import {
	nextWorktreeSlug,
	pathBasename,
	slugifyWorktree,
	worktreeBranchFor,
	worktreeBranchLabel,
	worktreePathFor,
} from "./sessionGroups.js";
import { toast } from "./toast.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureDashboardWorktree(next) {
	deps = installDeps("dashboardWorktree", "configureDashboardWorktree", next, ["refresh", "openSessionActions"]);
}

function worktreeBranches(listing) {
	return (Array.isArray(listing?.worktrees) ? listing.worktrees : []).map((entry) => entry.branch);
}

async function fetchWorktrees(cwd) {
	const listing = await apiJson(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
	const repo = typeof listing.repo === "string" ? listing.repo : cwd;
	return { repo, worktrees: Array.isArray(listing.worktrees) ? listing.worktrees : [] };
}

/** The confirm step for a new worktree; fetches the repo first for its real root. */
export async function openNewWorktreeSheet(cwd) {
	let listing;
	try {
		listing = await fetchWorktrees(cwd);
	} catch (error) {
		toast(`worktree: ${error.message}`);
		return;
	}
	const repo = listing.repo;
	const base = slugifyWorktree(pathBasename(repo)) || "worktree";
	const slug = nextWorktreeSlug(base, worktreeBranches(listing));
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";

	const form = document.createElement("form");
	form.className = "worktree-new";
	const heading = sheetHeader("new with worktree");

	const label = document.createElement("label");
	label.className = "worktree-label";
	label.textContent = "branch slug";
	const input = document.createElement("input");
	input.name = "slug";
	input.value = slug;
	input.autocapitalize = "off";
	input.autocorrect = "off";
	input.spellcheck = false;
	input.setAttribute("aria-label", "Worktree branch slug");
	label.append(input);

	const preview = document.createElement("div");
	preview.className = "worktree-preview";
	const hint = document.createElement("div");
	hint.className = "sheet-hint";
	hint.textContent =
		"Creates a branch from the repository's current HEAD. The slug is editable; collisions get a suffix.";

	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const create = document.createElement("button");
	create.type = "submit";
	create.className = "primary";
	create.textContent = "create worktree";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "cancel";
	cancel.addEventListener("click", closeSheet);
	actions.append(create, cancel);

	const update = () => {
		const value = slugifyWorktree(input.value) || "worktree";
		preview.textContent = `directory: ${worktreePathFor(repo, value)}\nbranch: ${worktreeBranchFor(value)}`;
	};
	input.addEventListener("input", update);
	update();

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = slugifyWorktree(input.value);
		if (!value) {
			input.focus();
			return;
		}
		if (worktreeBranches(listing).some((branch) => branch === worktreeBranchFor(value))) {
			input.value = nextWorktreeSlug(value, worktreeBranches(listing));
			update();
			const notice = form.querySelector(".worktree-error") ?? document.createElement("div");
			notice.className = "worktree-error";
			notice.textContent = `branch ${worktreeBranchFor(value)} already exists; suggested ${worktreeBranchFor(input.value)}`;
			form.insertBefore(notice, actions);
			input.focus();
			return;
		}
		closeSheet();
		beginNewSession(repo, { branch: value });
	});

	form.append(heading, label, preview, hint, actions);
	target.append(form);
	input.focus();
	input.select();
}

/** Open the manage sheet for one repo, with the group's worktree first. */
export async function openWorktreeSheet(group) {
	if (!group?.repo) return;
	let listing;
	try {
		listing = await fetchWorktrees(group.repo);
	} catch (error) {
		toast(`worktree: ${error.message}`);
		return;
	}
	const targetPath = group.kind === "worktree" ? group.cwd : "";
	const entries = [...listing.worktrees].sort((a, b) => {
		const target = Number(b.path === targetPath) - Number(a.path === targetPath);
		return target || a.branch.localeCompare(b.branch);
	});
	renderManageSheet(listing.repo, entries, targetPath);
}

function renderManageSheet(repo, entries, targetPath) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(`worktrees · ${pathBasename(repo) || repo}`);
	const hint = document.createElement("div");
	hint.className = "sheet-hint";
	hint.textContent =
		"Removing a worktree deletes its directory and git link, never the branch. Sessions keep their files.";
	const list = document.createElement("div");
	list.className = "worktree-list";
	for (const entry of entries) {
		const main = entry.path === repo;
		const row = document.createElement("div");
		row.className = "worktree-row";
		if (entry.path === targetPath) row.classList.add("target");
		const info = document.createElement("div");
		info.className = "worktree-info";
		const branch = document.createElement("div");
		branch.className = "worktree-branch";
		branch.textContent = main ? "main (repository)" : worktreeBranchLabel(entry.branch) || entry.branch;
		const path = document.createElement("div");
		path.className = "worktree-path";
		path.textContent = entry.path;
		path.title = entry.path;
		info.append(branch, path);
		if (entry.dirty && entry.changedFiles > 0) {
			const dirty = document.createElement("div");
			dirty.className = "worktree-dirty";
			dirty.textContent = `${entry.changedFiles} changed file${entry.changedFiles === 1 ? "" : "s"}`;
			info.append(dirty);
		}
		row.append(info);
		if (!main) {
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "danger";
			remove.textContent = entry.pixipActive ? "delete" : "external";
			remove.disabled = !entry.pixipActive;
			remove.title = entry.pixipActive
				? `Delete worktree ${entry.path}`
				: "This worktree was not created or used by pixip; it is never removed here";
			remove.addEventListener("click", () => confirmRemove(entry, false));
			row.append(remove);
		}
		list.append(row);
	}
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "close";
	cancel.addEventListener("click", closeSheet);
	actions.append(cancel);
	target.append(heading, hint, list, actions);
}

function confirmRemove(entry, force) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(force ? "delete anyway" : "delete worktree");
	const body = document.createElement("div");
	body.className = "sheet-text";
	body.textContent = force
		? `Delete ${worktreeBranchLabel(entry.branch) || entry.branch} with ${entry.changedFiles} changed file${entry.changedFiles === 1 ? "" : "s"}? Those changes are lost.`
		: `Delete the worktree for ${worktreeBranchLabel(entry.branch) || entry.branch}?\n\n${entry.path}${entry.dirty ? `\n\n${entry.changedFiles} changed file${entry.changedFiles === 1 ? "" : "s"} would be lost.` : ""}`;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "danger";
	remove.textContent = force ? "delete anyway" : entry.dirty ? "continue" : "delete";
	remove.addEventListener("click", () => {
		if (!force && entry.dirty) confirmRemove(entry, true);
		else void removeWorktree(entry, force);
	});
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "cancel";
	cancel.addEventListener("click", closeSheet);
	actions.append(remove, cancel);
	target.append(heading, body, actions);
}

async function removeWorktree(entry, force) {
	try {
		await apiJson("/api/worktrees", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: entry.repo,
				worktree: { branch: entry.branch },
				force,
			}),
		});
		closeSheet();
		toast(`removed worktree ${worktreeBranchLabel(entry.branch) || entry.branch}`);
		await deps.refresh();
	} catch (error) {
		if (error.body?.reason === "dirty") {
			confirmRemove({ ...entry, ...error.body.worktree }, true);
			return;
		}
		if (error.body?.reason === "referenced") {
			renderReferenced(entry, error.body.sessions ?? []);
			return;
		}
		if (error.body?.reason === "external") {
			toast("external worktree; pixip will not remove it");
			return;
		}
		toast(`worktree delete failed: ${error.message}`);
	}
}

function renderReferenced(entry, sessions) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("worktree in use");
	const body = document.createElement("div");
	body.className = "sheet-text";
	body.textContent = `${worktreeBranchLabel(entry.branch) || entry.branch} still has sessions. Stop, archive or delete them first; then retry.`;
	const list = document.createElement("div");
	list.className = "worktree-list";
	for (const session of sessions) {
		const row = document.createElement("div");
		row.className = "worktree-row";
		const info = document.createElement("div");
		info.className = "worktree-info";
		const name = document.createElement("div");
		name.className = "worktree-branch";
		name.textContent = session.name || String(session.id ?? "").slice(0, 8);
		const meta = document.createElement("div");
		meta.className = "worktree-path";
		meta.textContent = `${session.state ?? "stopped"} · ${session.cwd ?? entry.path}`;
		info.append(name, meta);
		const open = document.createElement("button");
		open.type = "button";
		open.textContent = "open";
		open.addEventListener("click", () => {
			closeSheet();
			openSession(session.id);
		});
		const actions = document.createElement("button");
		actions.type = "button";
		actions.textContent = "actions";
		actions.addEventListener("click", () => deps.openSessionActions(session));
		row.append(info, open, actions);
		list.append(row);
	}
	const footer = document.createElement("div");
	footer.className = "sheet-actions";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	footer.append(close);
	target.append(heading, body, list, footer);
}

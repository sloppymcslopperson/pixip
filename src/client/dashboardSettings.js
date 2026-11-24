// Dashboard settings, archive and trash surfaces. HTTP stays in dashboardApi,
// list re-rendering in dashboardList; this module owns only these sheets.
import { apiJson, fetchStored } from "./dashboardApi.js";
import { installDeps } from "./configure.js";
import { refreshDashboard, renderList } from "./dashboardList.js";
import { storedSheetModel } from "./dashboardModel.js";
import { forgetCachedSession } from "./navigation.js";
import { KEEP_ACTIVE_STORAGE_KEY, serializeKeepActive } from "./sessionGroups.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { actionToast, toast } from "./toast.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureDashboardSettings(next) {
	deps = installDeps("dashboardSettings", "configureDashboardSettings", next, ["sheet"]);
}

export function openSessionActions(session) {
	const label = session.name ?? session.id.slice(0, 8);
	const actions = [];
	const live = ["starting", "idle", "busy"].includes(session.state);
	if (live) actions.push(["stop", () => void stopSession(session)]);
	actions.push(["archive", () => confirmSessionAction("archive", session)]);
	actions.push(["delete", () => confirmSessionAction("delete", session)]);
	deps.sheet(`session · ${label}`, actions);
}

async function stopSession(session) {
	try {
		await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/stop`, { method: "POST" });
		await refreshDashboard();
		toast("stopped");
	} catch (error) {
		toast(`stop failed: ${error.message}`);
	}
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

export function archiveInactive(targets) {
	const sessions = Array.isArray(targets) ? targets.filter((session) => session?.id) : [];
	if (sessions.length === 0) return;
	const message = `Archive ${sessions.length} inactive session${sessions.length === 1 ? "" : "s"}? Groups with no active sessions keep their newest session.`;
	confirmSheet("archive", message, "archive", () => {
		closeSheet();
		void archiveInactiveConfirmed(sessions);
	});
}

async function archiveInactiveConfirmed(sessions) {
	try {
		const result = await apiJson("/api/sessions/archive-inactive", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: sessions.map((session) => session.id) }),
		});
		if (Array.isArray(result.archived)) for (const session of result.archived) forgetCachedSession(session);
		await refreshDashboard();
		const failed = Array.isArray(result.failed) ? result.failed.length : 0;
		toast(`archived ${result.archived ?? 0}${failed ? ` · ${failed} failed` : ""}`);
	} catch (error) {
		toast(`archive failed: ${error.message}`);
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
		[archived, trash] = await Promise.all([fetchStored("archive"), fetchStored("trash")]);
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
	try {
		renderStoredSheet(kind, await fetchStored(kind));
	} catch (error) {
		toast(`load failed: ${error.message}`);
	}
}

export function renderStoredSheet(kind, items) {
	const model = storedSheetModel(kind, items, state.home);
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader(model.title);
	const hint = document.createElement("div");
	hint.className = "settings-hint";
	hint.textContent = model.hint;
	const list = document.createElement("div");
	list.className = "stored-list";
	if (model.empty) {
		const empty = document.createElement("div");
		empty.className = "settings-hint";
		empty.textContent = model.empty;
		list.append(empty);
	}
	for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
		const row = document.createElement("div");
		row.className = "stored-row";
		const info = document.createElement("div");
		info.className = "stored-info";
		const name = document.createElement("div");
		name.className = "stored-name";
		name.textContent = model.rows[index].name;
		const meta = document.createElement("div");
		meta.className = "stored-meta";
		meta.textContent = model.rows[index].meta;
		info.append(name, meta);
		const actions = document.createElement("div");
		actions.className = "stored-actions";
		const restore = document.createElement("button");
		restore.textContent = "restore";
		restore.addEventListener("click", () => void restoreStored(kind, item));
		const remove = document.createElement("button");
		remove.textContent = model.archived ? "delete" : "purge";
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

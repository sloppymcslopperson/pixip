// Directory picker sheet: state transitions and DOM only. Path math stays in
// directoryPicker.js; HTTP stays in dashboardApi.js.
import { apiJson } from "./dashboardApi.js";
import { pickerPlan } from "./dashboardModel.js";
import { crumbTrail } from "./directoryPicker.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

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
	const plan = pickerPlan(picker, state.home);
	if (plan.loading) {
		list.append(dirMessage(plan.message));
		return;
	}
	if (plan.error) {
		error.textContent = plan.error;
		error.hidden = false;
	}
	if (!picker.listing) {
		list.append(dirMessage(plan.message));
		return;
	}
	if (plan.parent) {
		const up = dirButton("..", plan.parent, false, plan.parent);
		up.classList.add("dir-parent");
		list.append(up);
	}
	for (const entry of plan.entries) list.append(dirButton(entry.name, entry.path, Boolean(entry.repo), entry.path));
	if (plan.message) list.append(dirMessage(plan.message));
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

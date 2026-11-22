// Client sheets module; shared state and transport live in app.js.
import { applyAddonUi, copyText, flattenTree, notice, renderFooter, send, state, ui } from "./app.js";

export function openSessionSheet() {
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

export function openModelSheet(current) {
	const items = state.models.map((model) => [
		`${model.id === current ? "✓ " : ""}${model.id}${model.provider ? ` · ${model.provider}` : ""}`,
		() => {
			send({ t: "set_model", provider: model.provider, modelId: model.id });
			closeSheet();
		},
	]);
	sheet("model", items.length > 0 ? items : [["no models configured", () => closeSheet()]]);
}

export function openThinkingSheet(current) {
	const items = state.levels.map((level) => [
		`${level === current ? "✓ " : ""}${level}`,
		() => {
			send({ t: "set_thinking", level });
			closeSheet();
		},
	]);
	sheet("thinking", items.length > 0 ? items : [["no levels reported", () => closeSheet()]]);
}

export function sheet(title, items) {
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

export function closeSheet() {
	ui.sheet.hidden = true;
	ui.sheet.textContent = "";
	state.uiDialog = null;
}

export function sheetCloseButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "sheet-close";
	button.setAttribute("aria-label", "close");
	button.textContent = "×";
	button.addEventListener("click", dismissSheet);
	return button;
}

export function sheetHeader(title) {
	const header = document.createElement("div");
	header.className = "sheet-header";
	const heading = document.createElement("div");
	heading.className = "sheet-title";
	heading.textContent = title;
	header.append(heading, sheetCloseButton());
	return header;
}

export function sheetCloseRow() {
	const header = document.createElement("div");
	header.className = "sheet-header close-only";
	header.append(sheetCloseButton());
	return header;
}

export function dismissSheet() {
	const dialog = state.uiDialog;
	if (!dialog) {
		closeSheet();
		return;
	}
	send({ t: "ui", id: dialog.id, cancelled: true });
	closeSheet();
}

export const TREE_ROLE = {
	user: "you",
	assistant: "pi",
	toolResult: "tool",
	bashExecution: "bash",
	compaction: "compaction",
	branch_summary: "branch summary",
};

export function openTreeSheet(tree, leafId) {
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

export function openExportSheet(html, jsonl) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("export");
	const note = document.createElement("div");
	note.className = "sheet-text";
	note.textContent = "downloads only · nothing is sent to the model";
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	for (const [label, url] of [
		["download HTML", html],
		["download JSONL", jsonl],
	]) {
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

export function handleUiRequest(request) {
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

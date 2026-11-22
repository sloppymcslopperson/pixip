// Client menu module; shared state lives in kernel/state.js.
import {
	commandQuery,
	filterCommands,
	menuCatalog,
	menuInsertText,
	queueCount,
	queueFromEvent,
	queueTexts,
	restoreText,
	scheduleScroll,
	send,
	submit,
	toast,
} from "./app.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export function renderMenu() {
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

export function closeMenu() {
	const wasOpen = !ui.menu.hidden;
	ui.menu.hidden = true;
	state.menu.items = [];
	state.menu.index = 0;
	if (!wasOpen) return;
	ui.menu.textContent = "";
	scheduleScroll();
}

export function moveMenu(delta) {
	const count = state.menu.items.length;
	if (count === 0) return;
	state.menu.index = (state.menu.index + delta + count) % count;
	for (const [index, row] of [...ui.menu.children].entries()) {
		row.classList.toggle("active", index === state.menu.index);
		row.setAttribute("aria-selected", index === state.menu.index ? "true" : "false");
	}
	ui.menu.children[state.menu.index]?.scrollIntoView({ block: "nearest" });
}

export function chooseMenu(index) {
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

export function renderQueue() {
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

export function restoreClearedQueue(frame) {
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

export function resize() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

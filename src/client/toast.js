// Client toast module; the DOM map lives in kernel/ui.js.
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { ui } from "./kernel/ui.js";

export let toastTimer;

export function toast(message) {
	if (!message) return;
	ui.toast.textContent = message;
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, 3200);
}

export function actionToast(message, label, action, ms = 10_000) {
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

export const NOTICE_SHEET_CHARS = 180;

export function notice(message) {
	if (!message) return;
	if (message.includes("\n") || message.length > NOTICE_SHEET_CHARS) {
		textSheet("notice", message);
		return;
	}
	toast(message);
}

export function textSheet(title, text) {
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

export function openImageSheet(src) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const image = document.createElement("img");
	image.className = "sheet-image";
	image.src = src;
	image.alt = "attached image";
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(close);
	target.append(sheetHeader("image"), image, actions);
}

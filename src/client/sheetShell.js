// App-owned sheet shell primitives. They own the modal container only; feature
// modules build their own rows inside it. Kept separate so toast/composer do not
// depend on the whole sheets module.
import { ui } from "./kernel/ui.js";

export function closeSheet() {
	ui.sheet.hidden = true;
	ui.sheet.textContent = "";
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

export function dismissSheet() {
	closeSheet();
}

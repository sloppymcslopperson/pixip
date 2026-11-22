// Clipboard helpers shared by frames and sheets. Kept out of the composer so
// those modules do not import composer internals.
import { toast } from "./toast.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { ui } from "./kernel/ui.js";

export async function copyText(text) {
	if (typeof text !== "string" || !text.trim()) {
		toast("nothing to copy");
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		toast("copied");
	} catch {
		copySheet(text);
	}
}

export function copySheet(text) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = sheetHeader("copy");
	const body = document.createElement("pre");
	body.className = "sheet-text";
	body.textContent = text;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const copy = document.createElement("button");
	copy.textContent = "copy";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			toast("copied");
			closeSheet();
		} catch {
			toast("copy failed — select the text and copy manually");
		}
	});
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(copy, close);
	target.append(heading, body, actions);
}

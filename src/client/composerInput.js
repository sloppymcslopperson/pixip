// Shared composer input primitives. Composer orchestration and bash both clear
// and resize the same field, so neither imports the other's feature module.
import { closeMenu } from "./menuView.js";
import { refreshSendState } from "./sendState.js";
import { ui } from "./kernel/ui.js";

export function clearInput() {
	ui.input.value = "";
	closeMenu();
	resize();
	refreshSendState();
}

export function resize() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

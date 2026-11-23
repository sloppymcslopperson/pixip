// Shared command-menu visibility. The menu feature owns rendering; every other
// caller dismisses it through this seam.
import { scheduleScroll } from "./scroll.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

/** Close the command menu without depending on the menu feature module. */
export function closeMenu() {
	const wasOpen = !ui.menu.hidden;
	ui.menu.hidden = true;
	state.menu.items = [];
	state.menu.index = 0;
	if (!wasOpen) return;
	ui.menu.textContent = "";
	scheduleScroll();
}

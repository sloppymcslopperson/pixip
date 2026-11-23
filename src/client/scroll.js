// Shared transcript scroll seam. `#log` is the only scroll container, so any
// module that appends content or changes layout scrolls through here.
import { jumpHidden, restoreScrollTop } from "./transcriptScroll.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let scrollQueued = false;

export function updateJump() {
	ui.jump.hidden = jumpHidden(state.stick, ui.session.hidden);
}

export function scrollToEnd(force = false) {
	if (force) state.stick = true;
	updateJump();
	scheduleScroll();
}

export function scheduleScroll() {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		if (!state.stick) return;
		ui.log.scrollTop = ui.log.scrollHeight;
	});
}

/** Put the reader back at a saved distance after content prepends or a repaint. */
export function restoreDistance(distance) {
	ui.log.scrollTop = restoreScrollTop(distance, ui.log.scrollHeight);
}

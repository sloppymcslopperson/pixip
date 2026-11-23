// Shared queue-chip rendering. Dashboard, session, menu and transcript all
// repaint the same pending queue, so it lives below the features.
import { queueCount, queueTexts } from "./queue.js";
import { scheduleScroll } from "./scroll.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

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

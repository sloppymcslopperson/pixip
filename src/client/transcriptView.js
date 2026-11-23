// Shared append-only transcript DOM primitives. The painter in transcript.js
// owns windows and deltas; these are the small operations other features need
// without importing the transcript feature.
import { scheduleScroll } from "./scroll.js";
import { ui } from "./kernel/ui.js";

export function appendBlock(kind, html, raw = false) {
	const section = document.createElement(kind ? "section" : "div");
	if (kind) section.className = `block ${kind}`;
	if (raw) section.innerHTML = html;
	else section.textContent = html;
	ui.log.append(section);
	scheduleScroll();
	return section;
}

export function showThinkingIndicator() {
	if (ui.session.hidden) return;
	const existing = ui.log.querySelector(".thinking-indicator");
	if (existing) {
		// Keep it after the newest block (for example the real user message that
		// replaces the optimistic echo) without repainting it.
		if (existing !== ui.log.lastElementChild) ui.log.append(existing);
		return;
	}
	const section = document.createElement("div");
	section.className = "block meta thinking-indicator";
	section.textContent = "agent is thinking…";
	ui.log.append(section);
	scheduleScroll();
}

export function hideThinkingIndicator() {
	ui.log.querySelector(".thinking-indicator")?.remove();
}

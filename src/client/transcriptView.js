// Shared append-only transcript DOM primitives. The painter in transcript.js
// owns windows and deltas; these are the small operations other features need
// without importing the transcript feature.
import { thinkingBoxHtml, thinkingStatus } from "./render.js";
import { scheduleScroll } from "./scroll.js";
import { state } from "./kernel/state.js";
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

let thoughtQueued = false;

/** Paint into (or replace) the current indicator and return its element. */
function paintThinkingIndicator(existing, thought) {
	const text = typeof thought?.text === "string" ? thought.text : "";
	const active = thought?.active !== false;
	const open = existing?.tagName === "DETAILS" ? existing.open : thought?.expanded === true;
	const html = thinkingBoxHtml(text, { active, open });
	if (!html) {
		const plain = existing?.tagName === "DIV" ? existing : document.createElement("div");
		if (existing && existing !== plain) existing.replaceWith(plain);
		const status = thinkingStatus(active);
		plain.className = status.className;
		plain.textContent = status.summary;
		return plain;
	}
	const holder = document.createElement("div");
	holder.innerHTML = html;
	const box = holder.firstElementChild;
	if (existing) existing.replaceWith(box);
	else ui.log.append(box);
	return box;
}

export function showThinkingIndicator() {
	if (ui.session.hidden) return;
	const thought = state.liveThought;
	let existing = ui.log.querySelector(".thinking-indicator");
	existing = existing ? paintThinkingIndicator(existing, thought) : paintThinkingIndicator(null, thought);
	// Keep it after the newest block (for example the real user message that
	// replaces the optimistic echo) without repainting it.
	if (existing !== ui.log.lastElementChild) ui.log.append(existing);
	scheduleScroll();
}

/** Coalesce streaming deltas into one paint per animation frame. */
export function scheduleThinkingPaint() {
	if (thoughtQueued) return;
	thoughtQueued = true;
	requestAnimationFrame(() => {
		thoughtQueued = false;
		if (!state.liveThought?.text) return;
		showThinkingIndicator();
	});
}

export function hideThinkingIndicator() {
	ui.log.querySelector(".thinking-indicator")?.remove();
}

/** Persistent progress for compaction, separate from the turn's thinking row. */
export function showCompactionIndicator(text) {
	if (ui.session.hidden) return;
	let section = ui.log.querySelector(".compaction-indicator");
	if (!section) {
		section = document.createElement("div");
		section.className = "block meta compaction-indicator";
		ui.log.append(section);
		scheduleScroll();
	}
	section.textContent = text;
}

export function updateCompactionIndicator(text) {
	const section = ui.log.querySelector(".compaction-indicator");
	if (section) section.textContent = text;
}

export function hideCompactionIndicator() {
	ui.log.querySelector(".compaction-indicator")?.remove();
}

// Native disclosure: opening or closing it is the user's choice for this turn,
// and the final box keeps that choice when the assistant message ends.
ui.log.addEventListener(
	"toggle",
	(event) => {
		const details = event.target;
		if (details?.tagName !== "DETAILS" || !details.classList.contains("thinking-indicator")) return;
		if (state.liveThought) state.liveThought.expanded = details.open;
	},
	true,
);

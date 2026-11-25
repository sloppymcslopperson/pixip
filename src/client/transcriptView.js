// Shared append-only transcript DOM primitives. The painter in transcript.js
// owns windows and deltas; these are the small operations other features need
// without importing the transcript feature.
import { ansiToHtml } from "./render.js";
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

function thinkingSummary(thought) {
	return thought?.active === false ? "thinking" : "agent is thinking…";
}

function thinkingClass(thought) {
	const phase = thought?.active === false ? " done" : " active";
	return `block meta thinking-indicator${phase}`;
}

/** Paint into (or replace) the current indicator and return its element. */
function paintThinkingIndicator(existing, thought) {
	const text = typeof thought?.text === "string" ? thought.text : "";
	if (!text) {
		const plain = existing?.tagName === "DIV" ? existing : document.createElement("div");
		if (existing && existing !== plain) existing.replaceWith(plain);
		plain.className = thinkingClass(thought);
		plain.textContent = thinkingSummary(thought);
		return plain;
	}
	let details = existing?.tagName === "DETAILS" ? existing : null;
	const created = !details;
	if (!details) {
		details = document.createElement("details");
		details.innerHTML = '<summary></summary><div class="think-live"></div>';
		if (existing) existing.replaceWith(details);
	}
	details.className = thinkingClass(thought);
	if (created) details.open = thought?.expanded === true;
	const summary = details.querySelector("summary");
	if (summary) summary.textContent = thinkingSummary(thought);
	const body = details.querySelector(".think-live");
	if (body) body.innerHTML = ansiToHtml(text);
	return details;
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

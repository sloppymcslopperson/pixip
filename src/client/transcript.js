// Client transcript module; shared state lives in kernel/state.js.
import { appendBlock, hideThinkingIndicator, scheduleThinkingPaint, showThinkingIndicator } from "./transcriptView.js";
import { endCompaction, startCompaction } from "./compaction.js";
import { applyLiveThinkingFrame, applyThinkingEvent, createLiveThought } from "./thinkingStream.js";
import { installDeps } from "./configure.js";
import { renderQueue } from "./queueView.js";
import { decorateRefBlocks, stampRef, tagForLiveMessage } from "./reftagActions.js";
import { scheduleScroll, scrollToEnd } from "./scroll.js";
import { applyInfo, renderPeerNotice, setBusy } from "./sessionView.js";
import { queueCount, queueFromEvent } from "./queue.js";
import {
	escapeHtml,
	renderAssistant,
	renderAssistantBody,
	renderEntry,
	renderUserBody,
	summarizeArgs,
	textOf,
	toolBlock,
	toolCallsOf,
	toolResultParts,
} from "./render.js";
import { toast } from "./toast.js";
import { readingDistance, restoreScrollTop } from "./transcriptScroll.js";
import {
	FIRST_PAINT_BYTES,
	FILL_CHUNK_BYTES,
	entryWeight,
	lastEntryId,
	mergeTail as mergeWindow,
	oldestEntryId,
	planFillChunk,
	planFirstPaint,
	prependWindow,
	unseenEntries,
} from "./transcriptWindow.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureTranscript(next) {
	deps = installDeps("transcript", "configureTranscript", next, ["handleUiRequest"]);
}

export let fillTimer = 0;

export let fillToken = 0;

/** Assistant timestamp for the live coverage key, mirroring coverageKey(). */
let liveAssistantTs;

export function mergeTail(entries, more) {
	const result = mergeWindow(state.entries, entries, more);
	state.entries = result.entries;
	state.more = result.more;
}

export { FIRST_PAINT_BYTES, FILL_CHUNK_BYTES, entryWeight, lastEntryId, oldestEntryId };

/** Requests already in flight, so a toggle + button tap fetches once. */
const pendingFull = new Set();

function requestFull(entryId) {
	if (typeof entryId !== "string" || !entryId || pendingFull.has(entryId)) return;
	pendingFull.add(entryId);
	send({ t: "entry", id: entryId });
}

function detailsKey(details) {
	return details.dataset.call || details.className;
}

function callsFromEntries(entries) {
	const calls = new Map();
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			for (const call of toolCallsOf(entry.message.content)) calls.set(call.id, call);
		}
	}
	return calls;
}

function trackTools() {
	for (const node of ui.log.querySelectorAll(".tool[data-call]")) state.tools.set(node.dataset.call, node);
}

/** Every bounded-window block gets a visible way to ask for its full text. */
function trackTruncated() {
	for (const block of ui.log.querySelectorAll('[data-truncated="1"]')) {
		if (block.querySelector(":scope > .load-full")) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "load-full";
		button.dataset.entry = block.dataset.entry;
		button.textContent = "load full";
		block.append(button);
	}
}

/**
 * Mark snapshot entries so a block can be found and replaced after its full
 * text arrives. `truncated` is the fetchable window cap; `fullTruncated` is the
 * hard cap and deliberately gets no repeated fetch affordance.
 */
function tagEntry(html, entry) {
	if (!html || typeof entry?.id !== "string" || entry.id.length === 0) return html;
	const attrs = ` data-entry="${escapeHtml(entry.id)}"${entry.truncated === true ? ' data-truncated="1"' : ""}`;
	return html.replace(/^<(section|details)/, `<$1${attrs}`);
}

export function earlierButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "earlier";
	button.textContent = state.loadingEarlier ? "loading…" : "load earlier";
	button.disabled = state.loadingEarlier;
	button.addEventListener("click", () => {
		const before = oldestEntryId(state.entries);
		if (!before || state.loadingEarlier) return;
		state.loadingEarlier = true;
		button.textContent = "loading…";
		button.disabled = true;
		send({ t: "earlier", before });
	});
	return button;
}

function newestCompactionId(entries) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "compaction" && typeof entries[index].id === "string") return entries[index].id;
	}
	return null;
}

export function htmlOf(entries, calls) {
	const boundaryId = newestCompactionId(state.entries ?? []);
	const context = {
		sessionId: state.info?.id,
		compaction: boundaryId && state.compactionMeta?.id === boundaryId ? state.compactionMeta : null,
	};
	const blocks = [];
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			blocks.push(tagEntry(renderAssistant(entry.message.content, false), entry));
			continue;
		}
		if (entry?.type === "message" && entry.message?.role === "toolResult") {
			const call = calls.get(entry.message.toolCallId);
			const { output, image } = toolResultParts(entry.message, context.sessionId);
			blocks.push(
				tagEntry(
					toolBlock(
						entry.message.toolName ?? call?.name ?? "tool",
						call ? summarizeArgs(call.name, call.arguments) : "",
						output,
						entry.message.isError ? " error" : "",
						null,
						entry.message.toolCallId ?? "",
						{ image },
					),
					entry,
				),
			);
			continue;
		}
		blocks.push(tagEntry(renderEntry(entry, context), entry));
	}
	return blocks.join("");
}

/** Replace one block after its full entry arrives, keeping its open details. */
export function applyFullEntry(frame) {
	const id = typeof frame?.id === "string" ? frame.id : "";
	if (!id) return;
	pendingFull.delete(id);
	if (frame.error || !frame.entry) {
		toast(frame.error ?? "full text is not available yet");
		for (const button of ui.log.querySelectorAll(`.load-full[data-entry="${CSS.escape(id)}"]`)) {
			button.disabled = false;
			button.textContent = "load full";
		}
		return;
	}
	const entry = frame.entry;
	const index = state.entries.findIndex((item) => item?.id === id);
	if (index < 0) return;
	state.entries = state.entries.map((item, at) => (at === index ? entry : item));
	const node = ui.log.querySelector(`[data-entry="${CSS.escape(id)}"]`);
	if (!node) {
		renderTranscript();
		return;
	}
	const open = new Set([...node.querySelectorAll("details[open]")].map(detailsKey));
	const distance = readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop);
	node.outerHTML = htmlOf([entry], callsFromEntries(state.entries));
	const next = ui.log.querySelector(`[data-entry="${CSS.escape(id)}"]`);
	if (next) {
		for (const details of next.querySelectorAll("details")) {
			if (open.has(detailsKey(details))) details.open = true;
		}
	}
	ui.log.scrollTop = restoreScrollTop(distance, ui.log.scrollHeight);
	trackTools();
	trackTruncated();
	decorateRefBlocks(ui.log);
}

ui.log.addEventListener("click", (event) => {
	const button = event.target.closest(".load-full");
	if (!button) return;
	event.preventDefault();
	button.disabled = true;
	button.textContent = "loading…";
	requestFull(button.dataset.entry);
});

ui.log.addEventListener(
	"toggle",
	(event) => {
		const details = event.target;
		if (!(details instanceof HTMLDetailsElement) || !details.open) return;
		const block = details.closest('[data-truncated="1"]');
		if (block) requestFull(block.dataset.entry);
	},
	true,
);

export function renderTranscript(distance = null) {
	const restore = () => {
		if (distance !== null) ui.log.scrollTop = restoreScrollTop(distance, ui.log.scrollHeight);
	};
	clearTimeout(fillTimer);
	fillToken += 1;
	const token = fillToken;

	state.tools.clear();
	const calls = callsFromEntries(state.entries);

	const entries = state.entries;
	let { start } = planFirstPaint(entries, FIRST_PAINT_BYTES);
	const older = state.more && oldestEntryId(entries) ? earlierButton() : null;

	ui.log.innerHTML =
		entries.length === 0
			? '<div class="block meta">no messages yet — say something</div>'
			: htmlOf(entries.slice(start), calls);
	if (older) ui.log.prepend(older);
	renderPeerNotice();
	restore();
	trackTools();
	trackTruncated();
	decorateRefBlocks(ui.log);

	// Older entries of the same window fill in above, chunk by chunk. The
	// distance from the bottom is held constant, so a pinned view stays pinned.
	const fill = () => {
		if (token !== fillToken || start === 0) return;
		const { from } = planFillChunk(entries, start, FILL_CHUNK_BYTES);
		ui.log.insertAdjacentHTML("afterbegin", htmlOf(entries.slice(from, start), calls));
		if (older) ui.log.prepend(older);
		renderPeerNotice();
		restore();
		trackTools();
		trackTruncated();
		decorateRefBlocks(ui.log);
		start = from;
		if (start > 0) fillTimer = setTimeout(fill, 0);
	};
	if (start > 0) fillTimer = setTimeout(fill, 0);
}

export function renderSnapshot(entries, more) {
	// Pinned: stay at the bottom. Elsewhere: keep the same distance from the
	// bottom, which is exactly the same content once new entries are painted.
	const distance = readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop);
	if (state.stick) state.stick = true;
	mergeTail(entries, more);
	renderTranscript(distance);
}

export function renderResume(entries) {
	const fresh = unseenEntries(state.entries, entries);
	if (fresh.length === 0) return;
	const distance = readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop);
	state.entries = [...state.entries, ...fresh];
	renderTranscript(distance);
}

export function appendRestartNotice(interrupted) {
	const note = document.createElement("div");
	note.className = "block meta restart";
	note.textContent = interrupted ? "pixip restarted — the previous turn was interrupted" : "pixip restarted";
	ui.log.append(note);
	scrollToEnd();
}

export function prependHistory(entries, more) {
	state.loadingEarlier = false;
	const distance = readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop);
	const result = prependWindow(state.entries, entries, more);
	state.entries = result.entries;
	state.more = result.more;
	renderTranscript(distance);
}

export function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	switch (event.type) {
		case "agent_start":
			liveAssistantTs = undefined;
			setBusy(true);
			state.liveThought = createLiveThought(false);
			showThinkingIndicator();
			break;
		case "agent_settled":
			hideThinkingIndicator();
			state.liveThought = null;
			setBusy(false);
			break;
		case "message_start": {
			const message = event.message ?? {};
			if (message.role === "user") {
				state.pendingUser?.remove();
				state.pendingUser = null;
				const section = appendBlock("user", `<div class="who">you</div>${renderUserBody(message)}`, true);
				stampRef(section, tagForLiveMessage(message));
				if (state.info?.state === "busy") showThinkingIndicator();
			} else if (message.role === "assistant") {
				if (typeof message.timestamp === "number") liveAssistantTs = message.timestamp;
				// Lazy: the block is created by the first text delta, so a turn that
				// only thinks never leaves an empty labelled block behind.
				state.streaming = null;
				state.liveThought = {
					text: "",
					active: true,
					expanded: state.liveThought?.expanded === true,
				};
				showThinkingIndicator();
			}
			break;
		}
		case "message_update":
			handleDelta(event.assistantMessageEvent ?? {});
			handleThinkingEvent(event.assistantMessageEvent ?? {});
			break;
		case "message_end": {
			const message = event.message ?? {};
			if (message.role === "assistant") {
				if (typeof message.timestamp === "number") liveAssistantTs = message.timestamp;
				const expanded = state.liveThought?.expanded === true;
				hideThinkingIndicator();
				const body = renderAssistantBody(message.content ?? [], false, { openThinking: expanded });
				const section = state.streaming;
				state.streaming = null;
				if (section) {
					if (body) section.innerHTML = `<div class="who">pi</div>${body}`;
					else section.remove();
					if (body) stampRef(section, tagForLiveMessage(message));
				} else if (body) {
					const painted = appendBlock("assistant", `<div class="who">pi</div>${body}`, true);
					stampRef(painted, tagForLiveMessage(message));
				}
				state.liveThought = { text: "", active: false, expanded };
			}
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const call of toolCallsOf(message.content)) state.tools.get(call.id)?.setAttribute("data-name", call.name);
			}
			break;
		}
		case "tool_execution_start": {
			// The agent is running a tool, not thinking; the indicator returns with
			// the tool result if the turn continues.
			hideThinkingIndicator();
			if (state.liveThought) {
				state.liveThought.text = "";
				state.liveThought.active = false;
			}
			const summary = summarizeArgs(event.toolName, event.args);
			if (!event.toolName && !summary) break;
			const html = toolBlock(event.toolName, summary, "", "", null, event.toolCallId);
			const el = appendBlock("", html, true);
			el.classList.add("tool-host");
			if (event.toolCallId && el.firstElementChild) state.tools.set(event.toolCallId, el.firstElementChild);
			if (el.firstElementChild && typeof liveAssistantTs === "number") {
				stampRef(el.firstElementChild, tagForLiveMessage({ role: "assistant", timestamp: liveAssistantTs }));
			}
			break;
		}
		case "tool_execution_update": {
			const el = state.tools.get(event.toolCallId);
			const out = el?.querySelector(".tool-out");
			if (out && event.partialResult) out.textContent = textOf(event.partialResult.content);
			break;
		}
		case "tool_execution_end": {
			// The turn continues after a tool result, so show the thinking marker
			// again until the next assistant text/thinking arrives.
			if (state.info?.state === "busy") {
				state.liveThought = {
					text: "",
					active: true,
					expanded: state.liveThought?.expanded === true,
				};
				showThinkingIndicator();
			}
			const el = state.tools.get(event.toolCallId);
			if (!el) break;
			const result = event.result ?? {};
			const { output, image } = toolResultParts(
				{
					toolName: event.toolName ?? el.dataset.name ?? "tool",
					content: result.content,
					details: result.details,
				},
				state.info?.id,
			);
			if (image) {
				// An image card has a different shell (visible strip + folded text),
				// so replace the placeholder rather than patching one property.
				el.outerHTML = toolBlock(
					event.toolName ?? el.dataset.name ?? "tool",
					el.dataset.arg ?? "",
					output,
					event.isError ? " error" : "",
					event.durationMs,
					event.toolCallId,
					{ image },
				);
				const next = ui.log.querySelector(`.tool[data-call="${CSS.escape(event.toolCallId)}"]`);
				if (next) state.tools.set(event.toolCallId, next);
				if (next && typeof liveAssistantTs === "number") {
					stampRef(next, tagForLiveMessage({ role: "assistant", timestamp: liveAssistantTs }));
				}
				if (next) {
					if (event.isError) next.classList.add("error");
					const time = next.querySelector(".tool-time");
					if (time && event.durationMs) time.textContent = `${event.durationMs}ms`;
					next.classList.remove("empty");
				}
			} else {
				const out = el.querySelector(".tool-out");
				if (out) out.innerHTML = output;
				if (event.isError) el.classList.add("error");
				const time = el.querySelector(".tool-time");
				if (time && event.durationMs) time.textContent = `${event.durationMs}ms`;
				el.classList.remove("empty");
			}
			scheduleScroll();
			break;
		}
		case "bash_execution_update": {
			// Verbatim event, matched by the id the client put on the bash frame.
			const card = state.bash.get(event.id);
			const out = card?.querySelector(".bash-out");
			if (!out || typeof event.delta !== "string") break;
			out.textContent += event.delta;
			card.classList.remove("empty");
			scheduleScroll();
			break;
		}
		case "extension_ui_request":
			deps.handleUiRequest(event);
			break;
		case "queue_update": {
			// The event carries the complete queue: replace, never append.
			state.queue = queueFromEvent(event);
			if (queueCount(state.queue) > 0) {
				// The chips below are the honest pending state; the optimistic echo
				// would otherwise duplicate a message that has not reached Pi yet.
				state.pendingUser?.remove();
				state.pendingUser = null;
			}
			renderQueue();
			break;
		}
		case "session_info_changed":
			if (state.info) state.info.name = event.name;
			applyInfo();
			break;
		case "compaction_end":
			// Success adds a boundary that is not on the live event path, so the
			// transcript is re-requested. Abort/error leaves history untouched.
			if (endCompaction(event)) send({ t: "resnapshot" });
			break;
		case "auto_retry_start":
			toast(`retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? ""}`);
			break;
		case "compaction_start":
			startCompaction(event.reason);
			break;
		case "extension_error":
			toast(`extension error: ${event.error ?? event.message ?? ""}`);
			break;
		default:
			break;
	}
}

export function applyLiveThinking(frame) {
	if (!frame || typeof frame.text !== "string") return;
	state.liveThought = applyLiveThinkingFrame(state.liveThought, frame);
	if (state.liveThought.text || state.liveThought.active) showThinkingIndicator();
	else hideThinkingIndicator();
}

export function handleThinkingEvent(event) {
	const type = typeof event?.type === "string" ? event.type : "";
	if (type !== "thinking_start" && type !== "thinking_delta" && type !== "thinking_end") return;
	state.liveThought = applyThinkingEvent(state.liveThought, event);
	scheduleThinkingPaint();
}

export function handleDelta(delta) {
	if (delta.type !== "text_delta" && delta.type !== "text_end") return;
	if (!state.streaming) {
		state.streaming = appendBlock("assistant", '<div class="who">pi</div><div class="text live-text"></div>', true);
	}
	const target = state.streaming.querySelector(".live-text");
	if (!target) return;
	if (delta.type === "text_delta") {
		state.pending ??= "";
		state.pending += delta.delta ?? "";
		scheduleFlush(target);
	} else {
		state.pending = "";
		target.textContent = delta.content ?? target.textContent;
	}
}

export function scheduleFlush(target) {
	if (state.renderQueued) return;
	state.renderQueued = true;
	requestAnimationFrame(() => {
		state.renderQueued = false;
		const text = state.pending ?? "";
		state.pending = "";
		if (!text) return;
		target.textContent += text;
		scheduleScroll();
	});
}

// Client transcript module; shared state lives in kernel/state.js.
import {
	appendBlock,
	applyInfo,
	hideThinkingIndicator,
	renderQueue,
	scheduleScroll,
	scrollToEnd,
	setBusy,
	showThinkingIndicator,
} from "./controls.js";
import { queueCount, queueFromEvent } from "./queue.js";
import {
	ansiToHtml,
	renderAssistant,
	renderAssistantBody,
	renderEntry,
	renderUserBody,
	summarizeArgs,
	textOf,
	toolBlock,
	toolCallsOf,
} from "./render.js";
import { handleUiRequest } from "./sheets.js";
import { toast } from "./toast.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export const FIRST_PAINT_BYTES = 24 * 1024;

export const FILL_CHUNK_BYTES = 32 * 1024;

export let fillTimer = 0;

export let fillToken = 0;

export function mergeTail(entries, more) {
	const previous = state.entries;
	const ids = new Set(entries.map((entry) => entry?.id).filter(Boolean));
	const cut = previous.findIndex((entry) => entry?.id && ids.has(entry.id));
	const keep = cut > 0 ? cut : 0;
	const merged = [...previous.slice(0, keep), ...entries];
	const seen = new Set();
	const out = [];
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		const entry = merged[index];
		const id = entry?.id;
		if (typeof id === "string") {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		out.push(entry);
	}
	out.reverse();
	state.entries = out;
	state.more = more;
}

export function oldestEntryId() {
	return state.entries.find((entry) => typeof entry?.id === "string")?.id ?? null;
}

export function lastEntryId() {
	for (let index = state.entries.length - 1; index >= 0; index -= 1) {
		const id = state.entries[index]?.id;
		if (typeof id === "string") return id;
	}
	return null;
}

export function earlierButton() {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "earlier";
	button.textContent = state.loadingEarlier ? "loading…" : "load earlier";
	button.disabled = state.loadingEarlier;
	button.addEventListener("click", () => {
		const before = oldestEntryId();
		if (!before || state.loadingEarlier) return;
		state.loadingEarlier = true;
		button.textContent = "loading…";
		button.disabled = true;
		send({ t: "earlier", before });
	});
	return button;
}

export function entryWeight(entry) {
	try {
		return JSON.stringify(entry).length;
	} catch {
		return 512;
	}
}

export function htmlOf(entries, calls) {
	const blocks = [];
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			blocks.push(renderAssistant(entry.message.content, false));
			continue;
		}
		if (entry?.type === "message" && entry.message?.role === "toolResult") {
			const call = calls.get(entry.message.toolCallId);
			blocks.push(
				toolBlock(
					entry.message.toolName ?? call?.name ?? "tool",
					call ? summarizeArgs(call.name, call.arguments) : "",
					ansiToHtml(textOf(entry.message.content)),
					entry.message.isError ? " error" : "",
					null,
					entry.message.toolCallId ?? "",
				),
			);
			continue;
		}
		blocks.push(renderEntry(entry));
	}
	return blocks.join("");
}

export function renderTranscript(distance = null) {
	const restore = () => {
		if (distance !== null) ui.log.scrollTop = Math.max(0, ui.log.scrollHeight - distance);
	};
	clearTimeout(fillTimer);
	fillToken += 1;
	const token = fillToken;

	state.tools.clear();
	const calls = new Map();
	for (const entry of state.entries) {
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			for (const call of toolCallsOf(entry.message.content)) calls.set(call.id, call);
		}
	}

	const entries = state.entries;
	let start = entries.length;
	let bytes = 0;
	while (start > 0 && (bytes === 0 || bytes < FIRST_PAINT_BYTES)) {
		start -= 1;
		bytes += entryWeight(entries[start]);
	}
	const older = state.more && oldestEntryId() ? earlierButton() : null;

	ui.log.innerHTML =
		entries.length === 0
			? '<div class="block meta">no messages yet — say something</div>'
			: htmlOf(entries.slice(start), calls);
	if (older) ui.log.prepend(older);
	restore();
	const trackTools = () => {
		for (const node of ui.log.querySelectorAll("details.tool")) state.tools.set(node.dataset.call, node);
	};
	trackTools();

	// Older entries of the same window fill in above, chunk by chunk. The
	// distance from the bottom is held constant, so a pinned view stays pinned.
	const fill = () => {
		if (token !== fillToken || start === 0) return;
		let from = start;
		let chunkBytes = 0;
		while (from > 0 && chunkBytes < FILL_CHUNK_BYTES) {
			from -= 1;
			chunkBytes += entryWeight(entries[from]);
		}
		ui.log.insertAdjacentHTML("afterbegin", htmlOf(entries.slice(from, start), calls));
		if (older) ui.log.prepend(older);
		restore();
		trackTools();
		start = from;
		if (start > 0) fillTimer = setTimeout(fill, 0);
	};
	if (start > 0) fillTimer = setTimeout(fill, 0);
}

export function renderSnapshot(entries, more) {
	// Pinned: stay at the bottom. Elsewhere: keep the same distance from the
	// bottom, which is exactly the same content once new entries are painted.
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	if (state.stick) state.stick = true;
	mergeTail(entries, more);
	renderTranscript(distance);
}

export function renderResume(entries) {
	const known = new Set(state.entries.map((entry) => entry?.id).filter(Boolean));
	const fresh = entries.filter((entry) => typeof entry?.id !== "string" || !known.has(entry.id));
	if (fresh.length === 0) return;
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
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
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	const known = new Set(state.entries.map((entry) => entry?.id).filter(Boolean));
	const older = entries.filter((entry) => typeof entry?.id !== "string" || !known.has(entry.id));
	if (older.length > 0) state.entries = [...older, ...state.entries];
	state.more = more;
	renderTranscript(distance);
}

export function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	switch (event.type) {
		case "agent_start":
			setBusy(true);
			showThinkingIndicator();
			break;
		case "agent_settled":
			hideThinkingIndicator();
			setBusy(false);
			break;
		case "message_start": {
			const message = event.message ?? {};
			if (message.role === "user") {
				state.pendingUser?.remove();
				state.pendingUser = null;
				appendBlock("user", `<div class="who">you</div>${renderUserBody(message)}`, true);
				if (state.info?.state === "busy") showThinkingIndicator();
			} else if (message.role === "assistant") {
				// Lazy: the block is created by the first text delta, so a turn that
				// only thinks never leaves an empty labelled block behind.
				state.streaming = null;
			}
			break;
		}
		case "message_update":
			handleDelta(event.assistantMessageEvent ?? {});
			break;
		case "message_end": {
			const message = event.message ?? {};
			if (message.role === "assistant") {
				hideThinkingIndicator();
				const body = renderAssistantBody(message.content ?? [], false);
				const section = state.streaming;
				state.streaming = null;
				if (section) {
					if (body) section.innerHTML = `<div class="who">pi</div>${body}`;
					else section.remove();
				} else if (body) {
					appendBlock("assistant", `<div class="who">pi</div>${body}`, true);
				}
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
			const summary = summarizeArgs(event.toolName, event.args);
			if (!event.toolName && !summary) break;
			const html = toolBlock(event.toolName, summary, "", "", null, event.toolCallId);
			const el = appendBlock("", html, true);
			el.classList.add("tool-host");
			if (event.toolCallId && el.firstElementChild) state.tools.set(event.toolCallId, el.firstElementChild);
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
			if (state.info?.state === "busy") showThinkingIndicator();
			const el = state.tools.get(event.toolCallId);
			if (!el) break;
			const out = el.querySelector(".tool-out");
			if (out) out.innerHTML = ansiToHtml(textOf(event.result?.content));
			if (event.isError) el.classList.add("error");
			const time = el.querySelector(".tool-time");
			if (time && event.durationMs) time.textContent = `${event.durationMs}ms`;
			el.classList.remove("empty");
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
			handleUiRequest(event);
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
			// The compaction entry is not on the live event path and the context
			// window shrank: re-request the transcript the way it is now.
			send({ t: "resnapshot" });
			break;
		case "auto_retry_start":
			toast(`retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? ""}`);
			break;
		case "compaction_start":
			toast(`compacting (${event.reason})…`);
			break;
		case "extension_error":
			toast(`extension error: ${event.error ?? event.message ?? ""}`);
			break;
		default:
			break;
	}
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

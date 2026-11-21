import {
	ansiToHtml,
	escapeHtml,
	relativeTime,
	renderAssistant,
	renderAssistantBody,
	renderEntry,
	summarizeArgs,
	textOf,
	toolBlock,
	toolCallsOf,
} from "./render.js";
import {
	contextLevel,
	footerPwdLine,
	footerStatsLeft,
	footerStatsRight,
} from "./footer.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
	bar: $("#bar"),
	back: $("#back"),
	title: $("#title"),
	sub: $("#sub"),
	dot: $("#dot"),
	stop: $("#stop"),
	list: $("#list"),
	session: $("#session"),
	log: $("#log"),
	composer: $("#composer"),
	input: $("#input"),
	send: $("#send"),
	footer: $("#footer"),
	sheet: $("#sheet"),
	toast: $("#toast"),
};

const state = {
	sessionId: null,
	info: null,
	ws: null,
	retries: 0,
	stick: true,
	streaming: null, // { section, text }
	pendingUser: null,
	tools: new Map(), // toolCallId -> <details>
	coarse: window.matchMedia("(pointer: coarse)").matches,
	renderQueued: false,
	footer: null,
	models: [],
	levels: [],
	entries: [], // what the client currently knows, oldest first
	more: false, // older entries exist before entries[0]
	loadingEarlier: false,
};

// ------------------------------------------------------------------ transport

function socketUrl(sessionId) {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const suffix = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
	return `${scheme}://${location.host}/ws${suffix}`;
}

function connect(sessionId) {
	closeSocket();
	const ws = new WebSocket(socketUrl(sessionId));
	state.ws = ws;
	ws.onopen = () => {
		state.retries = 0;
	};
	ws.onmessage = (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		handleFrame(frame);
	};
	ws.onclose = () => {
		if (state.ws !== ws) return;
		state.ws = null;
		if (!state.sessionId) return;
		const delay = Math.min(2000, 200 * 2 ** state.retries++);
		toast(`reconnecting… (${delay}ms)`);
		setTimeout(() => connect(state.sessionId), delay);
	};
}

function closeSocket() {
	if (state.ws) {
		const ws = state.ws;
		state.ws = null;
		ws.onclose = null;
		ws.close();
	}
}

function send(frame) {
	if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(frame));
}

// -------------------------------------------------------------------- routing

function route() {
	const match = /^#s=(.+)$/.exec(location.hash);
	const id = match ? decodeURIComponent(match[1]) : null;
	if (id) openSession(id);
	else showList();
}

async function showList() {
	state.sessionId = null;
	state.info = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	ui.session.hidden = true;
	ui.composer.hidden = true;
	ui.footer.hidden = true;
	ui.stop.hidden = true;
	ui.back.hidden = true;
	ui.list.hidden = false;
	ui.title.textContent = "sessions";
	ui.sub.textContent = "";
	ui.dot.className = "dot idle";
	ui.dot.hidden = true;
	document.title = "pixip";

	connect(null);

	let info = {};
	try {
		info = await (await fetch("/api/info")).json();
	} catch {}
	const sessions = await listSessions();
	renderList(sessions, info.defaultCwd);
}

async function listSessions() {
	try {
		return await (await fetch("/api/sessions")).json();
	} catch {
		return [];
	}
}

function renderList(sessions, defaultCwd) {
	ui.list.textContent = "";
	const form = document.createElement("form");
	form.id = "new-row";
	form.innerHTML = `<input name="cwd" value="${escapeHtml(defaultCwd ?? "")}" placeholder="/path/to/project" autocapitalize="off" autocorrect="off" spellcheck="false" /><button type="submit">new</button>`;
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const cwd = form.querySelector("input")?.value?.trim();
		if (cwd) send({ t: "create", cwd });
	});
	ui.list.append(form);

	if (sessions.length === 0) {
		const empty = document.createElement("div");
		empty.className = "row row-state";
		empty.textContent = "no sessions yet";
		ui.list.append(empty);
		return;
	}
	for (const session of sessions) {
		const row = document.createElement("button");
		row.className = "row";
		row.dataset.id = session.id;
		row.innerHTML = `<div class="row-top"><span class="dot ${session.state}"></span><span class="row-name">${escapeHtml(session.name ?? session.id.slice(0, 8))}</span><span class="row-state">${escapeHtml(session.state)} · ${relativeTime(session.lastActivity)}</span></div><div class="row-cwd">${escapeHtml(session.cwd)}</div>`;
		row.addEventListener("click", () => {
			location.hash = `s=${encodeURIComponent(session.id)}`;
		});
		ui.list.append(row);
	}
}

function openSession(id) {
	if (state.sessionId === id) return;
	state.sessionId = id;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	ui.list.hidden = true;
	ui.session.hidden = false;
	ui.composer.hidden = false;
	ui.footer.hidden = false;
	ui.stop.hidden = false;
	ui.back.hidden = false;
	ui.log.textContent = "";
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.stick = true;
	ui.title.textContent = "connecting…";
	ui.sub.textContent = id.slice(0, 8);
	ui.dot.className = "dot busy";
	document.title = "pixip";
	connect(id);
}

// --------------------------------------------------------------------- frames

function handleFrame(frame) {
	switch (frame.t) {
		case "hello":
			if (!state.sessionId) void listSessions().then((sessions) => renderList(sessions, frame.defaultCwd));
			break;
		case "sessions":
			if (!state.sessionId) renderList(frame.sessions ?? [], undefined);
			break;
		case "snapshot":
			state.info = frame.session;
			renderSnapshot(frame.entries ?? [], frame.more === true);
			applyInfo();
			break;
		case "history":
			prependHistory(frame.entries ?? [], frame.more === true);
			break;
		case "status":
			if (frame.session?.id === state.sessionId || !state.sessionId) {
				state.info = frame.session;
				applyInfo();
			}
			break;
		case "opened": {
			const id = frame.session?.id;
			if (typeof id !== "string") break;
			if (state.sessionId && state.ws) {
				// An index-only session reattached under a new Pi id: keep this socket
				// and transcript, and move the URL to the new id without reconnecting.
				state.sessionId = id;
				history.replaceState(null, "", `#s=${encodeURIComponent(id)}`);
			} else {
				location.hash = `s=${encodeURIComponent(id)}`;
			}
			break;
		}
		case "event":
			handleEvent(frame.ev);
			break;
		case "footer":
			state.footer = frame.footer;
			renderFooter();
			break;
		case "models":
			state.models = frame.models ?? [];
			openModelSheet(frame.current);
			break;
		case "thinking":
			state.levels = frame.levels ?? [];
			openThinkingSheet(frame.current);
			break;
		case "error":
			if (state.loadingEarlier) {
				const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
				state.loadingEarlier = false;
				renderTranscript(distance);
			}
			toast(frame.message);
			break;
		default:
			break;
	}
}

function applyInfo() {
	const info = state.info;
	if (!info) return;
	const name = info.name ?? info.id.slice(0, 8);
	ui.title.textContent = name;
	document.title = `${name} · pixip`;
	// Separators live inside the `.wide` wrapper so hiding it on narrow screens
	// does not leave dangling "· ·" separators behind.
	let subtitle = escapeHtml(info.state);
	const wide = [info.model, info.thinkingLevel].filter(Boolean).map((part) => escapeHtml(part));
	if (wide.length > 0) subtitle += ` · <span class="wide">${wide.join(" · ")}</span>`;
	if (info.messageCount) subtitle += ` · ${info.messageCount} msg`;
	ui.sub.innerHTML = subtitle;
	ui.sub.title = [info.state, info.model, info.thinkingLevel].filter(Boolean).join(" · ");
	ui.dot.hidden = false;
	ui.dot.className = `dot ${info.state}`;
	const stopped = info.state === "stopped" || info.state === "error";
	const starting = info.state === "starting";
	ui.input.disabled = stopped || starting;
	ui.send.disabled = stopped || starting;
	// The provisional transcript is already readable; this only says the child
	// is still booting and live events have not started yet.
	let startingHint = ui.log.querySelector(".starting");
	if (starting && !startingHint) {
		startingHint = document.createElement("div");
		startingHint.className = "block meta starting";
		startingHint.textContent = "starting pi…";
		ui.log.append(startingHint);
		scrollToEnd();
	} else if (!starting) {
		startingHint?.remove();
	}
	if (stopped && !ui.log.querySelector(".wake")) {
		const wake = document.createElement("button");
		wake.className = "row wake";
		wake.textContent = info.state === "error" ? "restart session" : "wake session";
		wake.addEventListener("click", () => connect(state.sessionId));
		ui.log.append(wake);
		scrollToEnd();
	} else if (!stopped) {
		ui.log.querySelector(".wake")?.remove();
	}
}

// ---------------------------------------------------------------- snapshot

/** Bytes of DOM a 200-entry window costs; the first paint only pays for a slice. */
const FIRST_PAINT_BYTES = 24 * 1024;
const FILL_CHUNK_BYTES = 32 * 1024;

let fillTimer = 0;
let fillToken = 0;

/**
 * Merge an incoming window (provisional tail or authoritative snapshot) into the
 * client's entries. Windows the user already loaded stay; duplicates are dropped
 * in favour of the newer copy.
 */
function mergeTail(entries, more) {
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

function oldestEntryId() {
	return state.entries.find((entry) => typeof entry?.id === "string")?.id ?? null;
}

function earlierButton() {
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

/** Rough DOM cost of an entry, used to keep the first paint small. */
function entryWeight(entry) {
	try {
		return JSON.stringify(entry).length;
	} catch {
		return 512;
	}
}

function htmlOf(entries, calls) {
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

/**
 * Paint `state.entries`: the newest slice synchronously (the first-paint
 * budget), then the rest in chunks above it. `distance` is the target
 * `scrollHeight - scrollTop` (clientHeight for a pinned view), applied after
 * every chunk so prepended content never moves what the reader is looking at.
 * One innerHTML assignment per chunk instead of per entry.
 */
function renderTranscript(distance = null) {
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

	ui.log.innerHTML = entries.length === 0
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

/** Replace the transcript with a new window, keeping the reading position. */
function renderSnapshot(entries, more) {
	// Pinned: stay at the bottom. Elsewhere: keep the same distance from the
	// bottom, which is exactly the same content once new entries are painted.
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	if (state.stick) state.stick = true;
	mergeTail(entries, more);
	renderTranscript(distance);
}

/** Prepend one older window, keeping the reading position. */
function prependHistory(entries, more) {
	state.loadingEarlier = false;
	const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
	const known = new Set(state.entries.map((entry) => entry?.id).filter(Boolean));
	const older = entries.filter((entry) => typeof entry?.id !== "string" || !known.has(entry.id));
	if (older.length > 0) state.entries = [...older, ...state.entries];
	state.more = more;
	renderTranscript(distance);
}

// ------------------------------------------------------------------- events

function handleEvent(event) {
	if (!event || typeof event !== "object") return;
	switch (event.type) {
		case "agent_start":
			setBusy(true);
			break;
		case "agent_settled":
			setBusy(false);
			break;
		case "message_start": {
			const message = event.message ?? {};
			if (message.role === "user") {
				state.pendingUser?.remove();
				state.pendingUser = null;
				appendBlock("user", `<div class="who">you</div><div class="text">${ansiToHtml(textOf(message.content))}</div>`, true);
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
		case "extension_ui_request":
			handleUiRequest(event);
			break;
		case "session_info_changed":
			if (state.info) state.info.name = event.name;
			applyInfo();
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

function handleDelta(delta) {
	if (delta.type !== "text_delta" && delta.type !== "text_end") return;
	if (!state.streaming) {
		state.streaming = appendBlock(
			"assistant",
			'<div class="who">pi</div><div class="text live-text"></div>',
			true,
		);
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

function scheduleFlush(target) {
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

// -------------------------------------------------------------------- footer

function renderFooter() {
	const footer = state.footer;
	if (!footer) return;
	const pwd = ui.footer.querySelector(".pwd");
	const left = ui.footer.querySelector(".left");
	const right = ui.footer.querySelector(".right");
	pwd.textContent = footerPwdLine(footer);
	left.textContent = footerStatsLeft(footer);
	left.dataset.level = contextLevel(footer);
	right.textContent = footerStatsRight(footer);
}

ui.footer.addEventListener("click", () => {
	if (!state.sessionId) return;
	openSessionSheet();
});

function openSessionSheet() {
	const footer = state.footer;
	sheet("session", [
		[
			`model: ${footer?.model?.id ?? "unknown"}`,
			() => {
				send({ t: "models" });
			},
		],
		[
			`thinking: ${footer?.thinking ?? "unknown"}`,
			() => {
				send({ t: "thinking" });
			},
		],
	]);
}

function openModelSheet(current) {
	const items = state.models.map((model) => [
		`${model.id === current ? "✓ " : ""}${model.id}${model.provider ? ` · ${model.provider}` : ""}`,
		() => {
			send({ t: "set_model", provider: model.provider, modelId: model.id });
			closeSheet();
		},
	]);
	sheet("model", items.length > 0 ? items : [["no models configured", () => closeSheet()]]);
}

function openThinkingSheet(current) {
	const items = state.levels.map((level) => [
		`${level === current ? "✓ " : ""}${level}`,
		() => {
			send({ t: "set_thinking", level });
			closeSheet();
		},
	]);
	sheet("thinking", items.length > 0 ? items : [["no levels reported", () => closeSheet()]]);
}

/** Bottom sheet with a title and one button per action. */
function sheet(title, items) {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const heading = document.createElement("div");
	heading.className = "sheet-title";
	heading.textContent = title;
	target.append(heading);
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	for (const [label, action] of items) {
		const button = document.createElement("button");
		button.textContent = label;
		if (label.startsWith("✓ ")) button.classList.add("current");
		button.addEventListener("click", action);
		actions.append(button);
	}
	const cancel = document.createElement("button");
	cancel.textContent = "close";
	cancel.addEventListener("click", closeSheet);
	actions.append(cancel);
	target.append(actions);
}

function closeSheet() {
	ui.sheet.hidden = true;
	ui.sheet.textContent = "";
}

// --------------------------------------------------------------- ui dialogs

function handleUiRequest(request) {
	const method = request.method;
	if (method === "notify") {
		toast(request.message ?? "");
		return;
	}
	if (!["select", "confirm", "input", "editor"].includes(method)) return;
	const sheet = ui.sheet;
	sheet.hidden = false;
	sheet.textContent = "";
	const title = document.createElement("div");
	title.className = "sheet-title";
	title.textContent = request.title ?? request.message ?? method;
	sheet.append(title);
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	sheet.append(actions);

	const finish = (fields) => {
		send({ t: "ui", id: request.id, ...fields });
		sheet.hidden = true;
		sheet.textContent = "";
	};

	const addButton = (label, fields) => {
		const button = document.createElement("button");
		button.textContent = label;
		button.addEventListener("click", () => finish(fields));
		actions.append(button);
	};

	if (method === "select") {
		for (const option of request.options ?? []) addButton(String(option), { value: option });
	} else if (method === "confirm") {
		addButton(request.yesLabel ?? "yes", { confirmed: true });
		addButton(request.noLabel ?? "no", { confirmed: false });
	} else {
		const field = document.createElement(method === "editor" ? "textarea" : "input");
		if (method === "editor") field.rows = 6;
		field.value = request.value ?? request.initialValue ?? "";
		sheet.append(field);
		field.focus();
		addButton("send", { value: field.value });
		actions.lastElementChild?.addEventListener("click", () => finish({ value: field.value }));
	}
	addButton("cancel", { cancelled: true });
}

// ------------------------------------------------------------------ composer

function submit() {
	const text = ui.input.value.trim();
	if (!text) return;
	const busy = state.info?.state === "busy";
	send({ t: busy ? "steer" : "prompt", text });
	state.pendingUser = appendBlock("user", `<div class="who">you</div><div class="text">${escapeHtml(text)}</div>`, true);
	ui.input.value = "";
	resize();
	scrollToEnd(true);
}

ui.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	submit();
});

ui.input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !state.coarse) {
		event.preventDefault();
		submit();
	}
});
ui.input.addEventListener("input", resize);

function resize() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
}

ui.back.addEventListener("click", () => {
	location.hash = "";
});
ui.stop.addEventListener("click", () => {
	send({ t: "stop" });
});

window.addEventListener("hashchange", route);

// ----------------------------------------------------------------- plumbing

function appendBlock(kind, html, raw = false) {
	const section = document.createElement(kind ? "section" : "div");
	if (kind) section.className = `block ${kind}`;
	if (raw) section.innerHTML = html;
	else section.textContent = html;
	ui.log.append(section);
	scheduleScroll();
	return section;
}

function setBusy(busy) {
	if (state.info) {
		state.info.state = busy ? "busy" : "idle";
		applyInfo();
	}
}

function scrollToEnd(force = false) {
	if (force) state.stick = true;
	scheduleScroll();
}

let scrollQueued = false;
function scheduleScroll() {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		if (!state.stick) return;
		ui.log.scrollTop = ui.log.scrollHeight;
	});
}

ui.log.addEventListener("scroll", () => {
	const distance = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight;
	state.stick = distance < 80;
});

let toastTimer;
function toast(message) {
	if (!message) return;
	ui.toast.textContent = message;
	ui.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		ui.toast.hidden = true;
	}, 3200);
}

route();

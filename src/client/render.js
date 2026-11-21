// Pure rendering helpers. No DOM: the browser loads this as a module and
// `node --test` imports the same file, so what the tests cover is what ships.
// Markdown lives in `./markdown.js`, which imports the vendored renderer.

import { escapeHtml, markdownToHtml } from "./markdown.js";

export { escapeHtml };

const SGR = /\u001b\[([0-9;]*)m/y;
const OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC = /\u001b[@-Z\\-_]/g;

/** ANSI SGR -> spans. Cursor moves, OSC titles and other CSI are dropped. */
export function ansiToHtml(text) {
	// CR without LF means "overwrite this line" (progress bars): keep the last segment.
	const input = String(text).replace(/[^\n\r]*\r(?!\n)/g, "");
	let html = "";
	let index = 0;
	let state = {};
	let open = false;

	const styleOf = () => {
		const parts = [];
		if (state.fg) parts.push(`color:${state.fg}`);
		if (state.bg) parts.push(`background:${state.bg}`);
		if (state.bold) parts.push("font-weight:700");
		if (state.dim) parts.push("opacity:.65");
		if (state.italic) parts.push("font-style:italic");
		if (state.underline) parts.push("text-decoration:underline");
		if (state.invert) parts.push("filter:invert(1)");
		return parts.join(";");
	};
	const close = () => {
		if (open) html += "</span>";
		open = false;
	};

	while (index < input.length) {
		const char = input[index];
		if (char === "\u001b") {
			SGR.lastIndex = index;
			const sgr = SGR.exec(input);
			if (sgr) {
				close();
				applySgr(state, sgr[1] ?? "");
				index = SGR.lastIndex;
				const style = styleOf();
				if (style) {
					html += `<span style="${style}">`;
					open = true;
				}
				continue;
			}
			const rest = input.slice(index);
			const osc = /^\u001b\][^\u0007]*(?:\u0007|\u001b\\)/.exec(rest);
			if (osc) {
				index += osc[0].length;
				continue;
			}
			const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
			if (csi) {
				index += csi[0].length;
				continue;
			}
			index += 1;
			continue;
		}
		let end = index;
		while (end < input.length && input[end] !== "\u001b") end += 1;
		html += escapeHtml(input.slice(index, end));
		index = end;
	}
	close();
	return html;
}

const FG = ["#f5f5f5", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
	"#4e5568", "#ff899d", "#b9f27c", "#ffd08a", "#9ab8ff", "#d0a9ff", "#a4e8ff", "#ffffff"];

function applySgr(state, params) {
	const codes = params.length === 0 ? [0] : params.split(";").map((part) => (part === "" ? 0 : Number(part)));
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index];
		if (code === 0) state = Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, invert: false });
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.invert = true;
		else if (code === 22) { state.bold = false; state.dim = false; }
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code === 27) state.invert = false;
		else if (code >= 30 && code <= 37) state.fg = FG[code - 30];
		else if (code === 39) state.fg = null;
		else if (code >= 90 && code <= 97) state.fg = FG[code - 90 + 8];
		else if (code >= 40 && code <= 47) state.bg = FG[code - 40];
		else if (code === 49) state.bg = null;
		else if (code >= 100 && code <= 107) state.bg = FG[code - 100 + 8];
		else if (code === 38 || code === 48) {
			const target = code === 38 ? "fg" : "bg";
			const mode = codes[index + 1];
			if (mode === 5) {
				const n = codes[index + 2] ?? 0;
				state[target] = xterm256(n);
				index += 2;
			} else if (mode === 2) {
				state[target] = `rgb(${codes[index + 2] ?? 0},${codes[index + 3] ?? 0},${codes[index + 4] ?? 0})`;
				index += 4;
			}
		}
	}
}

function xterm256(n) {
	if (n < 16) return FG[n];
	if (n >= 232) {
		const level = 8 + (n - 232) * 10;
		return `rgb(${level},${level},${level})`;
	}
	const value = n - 16;
	const r = Math.floor(value / 36);
	const g = Math.floor((value % 36) / 6);
	const b = value % 6;
	const channel = (part) => (part === 0 ? 0 : part * 40 + 55);
	return `rgb(${channel(r)},${channel(g)},${channel(b)})`;
}

/** One-line summary for a tool call header. */
export function summarizeArgs(name, args) {
	if (!args || typeof args !== "object") return "";
	const pick = (key) => (typeof args[key] === "string" ? args[key] : undefined);
	const text = [pick("command"), pick("path"), pick("pattern"), pick("url"), pick("query"), pick("file_path")].find(Boolean);
	if (!text) return "";
	return text.replace(/\s+/g, " ").slice(0, 96);
}

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && (block.type === "text" || block.type === "thinking"))
		.map((block) => block.text ?? block.thinking ?? "")
		.join("");
}

/** Snapshot path: a persisted session entry -> html. */
export function renderEntry(entry) {
	if (!entry || typeof entry !== "object") return "";
	if (entry.type === "compaction" || entry.type === "branchSummary") {
		const label = entry.type === "compaction" ? "compacted" : "branch summary";
		const summary = ansiToHtml(textOf(entry.summary ?? entry.message ?? ""));
		return `<section class="block meta"><div class="meta-head">${label}</div><div class="meta-body">${summary}</div></section>`;
	}
	if (entry.type !== "message") return "";
	return renderMessage(entry.message);
}

/** Snapshot path: a message -> html. */
export function toolCallsOf(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block && block.type === "toolCall");
}

export function renderMessage(message) {
	if (!message || typeof message !== "object") return "";
	if (message.role === "user") {
		const text = escapeHtml(textOf(message.content) || "[image]");
		return `<section class="block user"><div class="who">you</div><div class="text">${text}</div></section>`;
	}
	if (message.role === "assistant") {
		return renderAssistant(message.content ?? []);
	}
	if (message.role === "toolResult") {
		const output = ansiToHtml(textOf(message.content));
		const error = message.isError ? " error" : "";
		return toolBlock(message.toolName ?? "tool", "", output, error, null, message.toolCallId ?? "");
	}
	if (message.role === "bashExecution") {
		const output = ansiToHtml(textOf(message.output ?? message.content));
		return toolBlock("bash", message.command ?? "", output, message.exitCode === 0 ? "" : " error", null, "");
	}
	if (message.role === "custom") {
		return `<section class="block meta"><div class="meta-head">${escapeHtml(message.customType ?? "note")}</div><div class="meta-body">${ansiToHtml(textOf(message.content))}</div></section>`;
	}
	return "";
}

export function renderAssistant(content, includeTools = true) {
	const body = renderAssistantBody(content, includeTools);
	if (!body) return "";
	return `<section class="block assistant"><div class="who">pi</div>${body}</section>`;
}

/** Just the inside of an assistant block (no wrapper, no "pi" label). */
export function renderAssistantBody(content, includeTools = true) {
	let html = "";
	const text = [];
	const tools = [];
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text") text.push(block.text ?? "");
		else if (block.type === "thinking") {
			const inner = ansiToHtml(block.thinking ?? "");
			if (inner.trim()) html += `<details class="think"><summary>thinking</summary><div>${inner}</div></details>`;
		} else if (block.type === "toolCall") tools.push(block);
	}
	const body = markdownToHtml(text.join(""));
	if (body.trim()) html += `<div class="text">${body}</div>`;
	if (includeTools) {
		for (const call of tools) html += toolBlock(call.name, summarizeArgs(call.name, call.arguments), "", "", null, call.id ?? "");
	}
	return html;
}

export function toolBlock(name, summary, output, extraClass, durationMs, callId) {
	const head = `<span class="tool-name">${escapeHtml(name)}</span>${summary ? ` <span class="tool-arg">${escapeHtml(summary)}</span>` : ""}`;
	const timing = typeof durationMs === "number" ? `<span class="tool-time">${durationMs}ms</span>` : "";
	const open = output ? "" : " empty";
	return `<details class="tool${extraClass ?? ""}${open}" data-call="${escapeHtml(callId ?? "")}"><summary>${head}${timing}</summary><pre class="tool-out">${output}</pre></details>`;
}

export function relativeTime(ms) {
	if (!ms) return "";
	const delta = Date.now() - ms;
	if (delta < 60_000) return "now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

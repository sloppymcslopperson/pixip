// Pure rendering helpers. No DOM: the browser loads this as a module and
// `node --test` imports the same file, so what the tests cover is what ships.
// Markdown lives in `./markdown.js`, which imports the vendored renderer.

import { formatTokens } from "./footer.js";
import { escapeHtml, markdownToHtml } from "./markdown.js";

export { escapeHtml };

/** History row while the dashboard's `new` action is waiting for Pi. */
export function pendingSessionHtml() {
	return '<div class="block meta starting pending-session">starting session…</div>';
}

/** History row when creating the session failed before any id existed. */
export function pendingErrorHtml(message) {
	return `<div class="block meta error pending-session">could not start session: ${escapeHtml(message)}</div>`;
}

const SGR = /\u001b\[([0-9;]*)m/y;
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

const FG = [
	"#f5f5f5",
	"#f7768e",
	"#9ece6a",
	"#e0af68",
	"#7aa2f7",
	"#bb9af7",
	"#7dcfff",
	"#c0caf5",
	"#4e5568",
	"#ff899d",
	"#b9f27c",
	"#ffd08a",
	"#9ab8ff",
	"#d0a9ff",
	"#a4e8ff",
	"#ffffff",
];

function applySgr(state, params) {
	const codes = params.length === 0 ? [0] : params.split(";").map((part) => (part === "" ? 0 : Number(part)));
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index];
		if (code === 0)
			state = Object.assign(state, {
				fg: null,
				bg: null,
				bold: false,
				dim: false,
				italic: false,
				underline: false,
				invert: false,
			});
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.invert = true;
		else if (code === 22) {
			state.bold = false;
			state.dim = false;
		} else if (code === 23) state.italic = false;
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
	const text = [pick("command"), pick("path"), pick("pattern"), pick("url"), pick("query"), pick("file_path")].find(
		Boolean,
	);
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

/** Compact durations without dragging the reader through sub-second noise. */
export function formatDuration(ms) {
	const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function formatClock(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Live status line while Pi is summarizing the context. */
export function compactionStatusText(reason, elapsedMs, hasDraft = false) {
	const phase = typeof reason === "string" && reason ? reason : "manual";
	const draft = hasDraft ? " · draft kept" : "";
	return `compacting context (${phase})… ${formatDuration(elapsedMs)}${draft}`;
}

/** One-line boundary label; `meta` is only known for the just-finished compaction. */
export function compactionBoundaryLabel(entry, meta) {
	const parts = ["compacted"];
	if (meta && typeof meta.durationMs === "number") parts.push(formatDuration(meta.durationMs));
	if (typeof entry.tokensBefore === "number") {
		const before = formatTokens(entry.tokensBefore);
		parts.push(
			meta && typeof meta.estimatedTokensAfter === "number"
				? `${before} → ~${formatTokens(meta.estimatedTokensAfter)}`
				: `${before} before`,
		);
	}
	const clock = formatClock(entry.timestamp);
	if (clock) parts.push(clock);
	return parts.join(" · ");
}

/** Snapshot path: a persisted session entry -> html. */
export function renderEntry(entry, context) {
	if (!entry || typeof entry !== "object") return "";
	if (entry.type === "compaction") {
		const meta = context?.compaction?.id === entry.id ? context.compaction : null;
		const summary = ansiToHtml(textOf(entry.summary ?? entry.message ?? ""));
		const label = escapeHtml(compactionBoundaryLabel(entry, meta));
		return `<details class="compact-boundary"><summary>${label}</summary><div class="meta-body">${summary}</div></details>`;
	}
	if (entry.type === "branchSummary") {
		const summary = ansiToHtml(textOf(entry.summary ?? entry.message ?? ""));
		return `<section class="block meta"><div class="meta-head">branch summary</div><div class="meta-body">${summary}</div></section>`;
	}
	if (entry.type !== "message") return "";
	return renderMessage(entry.message, entry.id, context);
}

/** The one tool whose image blocks are intentional display, not tool output. */
export const SHOW_IMAGE_TOOL = "show_image_to_user";

/** Snapshot path: a message -> html. */
export function toolCallsOf(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block && block.type === "toolCall");
}

function imageOf(content) {
	if (!Array.isArray(content)) return null;
	return (
		content.find(
			(block) =>
				block && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
		) ?? null
	);
}

/** Only `show_image_to_user` results are deliberate displays; `read` stays text. */
export function toolResultImage(toolName, content) {
	if (toolName !== SHOW_IMAGE_TOOL) return null;
	return imageOf(content);
}

/** Hub route for the original file; the browser cannot follow a `file://` link. */
export function sessionFileHref(sessionId, path) {
	if (typeof sessionId !== "string" || !sessionId || typeof path !== "string" || !path) return undefined;
	return `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`;
}

function fileUrl(path) {
	return path.startsWith("/") ? `file://${encodeURI(path)}` : path;
}

function sizeLabel(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "unknown size";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / (1024 * 1024);
	return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

/** Text beside a displayed image: caption, size note and a download link. */
export function showImageTextHtml(details, sessionId) {
	if (!details || typeof details !== "object") return "";
	const path = typeof details.path === "string" ? details.path : "";
	const caption = typeof details.caption === "string" ? details.caption : "";
	const url = fileUrl(path);
	const href = sessionFileHref(sessionId, path) ?? url;
	const label = details.thumbnail ? "download original" : escapeHtml(url);
	const link = url ? `<a class="tool-download" href="${escapeHtml(href)}" download>${label}</a>` : escapeHtml(path);
	const lines = [];
	if (caption) lines.push(escapeHtml(caption));
	if (details.tooLarge) {
		lines.push(`File is ${sizeLabel(details.bytes)}, over the 20 MB limit; showing a link only.`);
	} else if (details.thumbnail) {
		lines.push(`File is ${sizeLabel(details.bytes)}, over the 1 MB limit; showing a thumbnail.`);
	} else if (details.overSourceLimit) {
		lines.push(`File is ${sizeLabel(details.bytes)}, over the 1 MB limit; a thumbnail could not be made.`);
	}
	lines.push(`Download: ${link}`);
	return lines.join("\n");
}

/**
 * Output html plus the one renderable image for a tool result. Kept here so the
 * snapshot, live event and full-entry paths share the same rules.
 */
export function toolResultParts(message, sessionId) {
	const toolName = message?.toolName ?? "tool";
	const image = toolResultImage(toolName, message?.content);
	const details = message?.details;
	const output =
		toolName === SHOW_IMAGE_TOOL && details && typeof details === "object"
			? showImageTextHtml(details, sessionId)
			: ansiToHtml(textOf(message?.content));
	return { output, image };
}

/** Inside a user block: text plus any recorded image thumbnails. */
export function renderUserBody(message) {
	const content = message?.content;
	const text = escapeHtml(textOf(content));
	const images = Array.isArray(content)
		? content.filter(
				(block) =>
					block && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
			)
		: [];
	const thumbs = images
		.map(
			(block) =>
				`<button type="button" class="msg-image" aria-label="Open attached image"><img src="data:${escapeHtml(block.mimeType)};base64,${block.data}" alt="attached image" loading="lazy" /></button>`,
		)
		.join("");
	const textHtml = text
		? `<div class="text">${text}</div>`
		: images.length === 0
			? '<div class="text">[image]</div>'
			: "";
	return `${textHtml}${thumbs ? `<div class="msg-images">${thumbs}</div>` : ""}`;
}

export function renderMessage(message, entryId, context = {}) {
	if (!message || typeof message !== "object") return "";
	if (message.role === "user") {
		// Snapshot entries carry their id; live `message_start` records do not, so
		// the affordance appears once the message is part of the loaded window.
		const fork =
			typeof entryId === "string" && entryId
				? ` <button type="button" class="fork-action" data-fork="${escapeHtml(entryId)}" aria-label="Fork from this message" title="Fork from this message">fork</button>`
				: "";
		return `<section class="block user"><div class="who">you${fork}</div>${renderUserBody(message)}</section>`;
	}
	if (message.role === "assistant") {
		return renderAssistant(message.content ?? []);
	}
	if (message.role === "toolResult") {
		const { output, image } = toolResultParts(message, context.sessionId);
		const error = message.isError ? " error" : "";
		return toolBlock(message.toolName ?? "tool", "", output, error, null, message.toolCallId ?? "", { image });
	}
	if (message.role === "bashExecution") {
		return bashCardHtml(message);
	}
	if (message.role === "custom") {
		return `<section class="block meta"><div class="meta-head">${escapeHtml(message.customType ?? "note")}</div><div class="meta-body">${ansiToHtml(textOf(message.content))}</div></section>`;
	}
	return "";
}

/**
 * One `!`/`!!` card: the command, its streamed output, and the terminal state
 * (exit code, cancelled, truncation, full-output path). `excluded` marks `!!`,
 * whose output Pi keeps in the session but leaves out of the model context.
 * Used live (optimistic card, then the final frame) and from snapshots, so a
 * reload repaints the same card.
 */
/** State for the optimistic bash card shown before the hub answers. */
export function bashStartCard(command, excludeFromContext) {
	return {
		command,
		output: "",
		exitCode: null,
		cancelled: false,
		truncated: false,
		excludeFromContext,
		running: true,
	};
}

export function bashCardHtml(message) {
	const command = message.command ?? "";
	const output = textOf(message.output ?? message.content ?? "");
	const excluded = message.excludeFromContext === true;
	const meta = [];
	if (message.cancelled) meta.push("cancelled");
	else if (typeof message.exitCode === "number") meta.push(`exit ${message.exitCode}`);
	if (message.truncated) meta.push("truncated");
	if (message.fullOutputPath) meta.push(`full output: ${message.fullOutputPath}`);
	if (message.running) meta.push("running…");
	const classes = ["block", "bash"];
	if (excluded) classes.push("excluded");
	if (message.running) classes.push("running");
	if (message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0)) classes.push("error");
	if (!output) classes.push("empty");
	const badge = excluded ? '<span class="badge excluded">excluded</span>' : "";
	return `<section class="${classes.join(" ")}"><div class="bash-head"><span class="bash-prompt">$</span><span class="bash-cmd">${escapeHtml(command)}</span>${badge}</div><pre class="bash-out">${escapeHtml(output)}</pre><div class="bash-meta">${escapeHtml(meta.join(" · "))}</div></section>`;
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
		for (const call of tools)
			html += toolBlock(call.name, summarizeArgs(call.name, call.arguments), "", "", null, call.id ?? "");
	}
	return html;
}

export function toolBlock(name, summary, output, extraClass, durationMs, callId, options = {}) {
	const head = `<span class="tool-name">${escapeHtml(name)}</span>${summary ? ` <span class="tool-arg">${escapeHtml(summary)}</span>` : ""}`;
	const timing = typeof durationMs === "number" ? `<span class="tool-time">${durationMs}ms</span>` : "";
	const attrs = `data-call="${escapeHtml(callId ?? "")}" data-name="${escapeHtml(name)}"${summary ? ` data-arg="${escapeHtml(summary)}"` : ""}`;
	const image = options.image;
	if (image) {
		// Visible while the text stays folded: the image is the point of the call.
		const thumb = `<button type="button" class="msg-image tool-image" aria-label="Open image shown by the agent"><img src="data:${escapeHtml(image.mimeType)};base64,${image.data}" alt="image shown by the agent" /></button>`;
		const text = output
			? `<details class="tool-text"><summary><span class="tool-text-label">output</span></summary><pre class="tool-out">${output}</pre></details>`
			: "";
		return `<section class="tool image-card${extraClass ?? ""}" ${attrs}><div class="tool-head">${head}${timing}</div><div class="msg-images tool-images">${thumb}</div>${text}</section>`;
	}
	const open = output ? "" : " empty";
	return `<details class="tool${extraClass ?? ""}${open}" ${attrs}><summary>${head}${timing}</summary><pre class="tool-out">${output}</pre></details>`;
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

// Client composer module; shared state lives in kernel/state.js.
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_IMAGE_SOURCE_BYTES,
	MAX_UPLOAD_BYTES,
	attachmentPrompt,
	looksLikeImage,
	sizeLabel,
} from "./attachments.js";
import { classifyInput, isAllowed } from "./commands.js";
import { appendBlock, closeMenu, resize, scheduleScroll, scrollToEnd, updateJump } from "./controls.js";
import { bashCardHtml, renderUserBody } from "./render.js";
import { formatSession } from "./sessionInfo.js";
import { refreshSendState } from "./sendState.js";
import { notice, textSheet, toast } from "./toast.js";
import { renderSnapshot } from "./transcript.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export const builtinHandlers = {
	compact(args) {
		send({ t: "compact", ...(args ? { instructions: args } : {}) });
	},
	name(args) {
		if (!args) {
			toast(`name: ${state.info?.name || "(unnamed)"}`);
			return;
		}
		send({ t: "set_session_name", name: args });
	},
	session() {
		textSheet("session", formatSession(state.info, state.footer));
	},
	copy() {
		send({ t: "copy" });
	},
	model(args) {
		if (!args) {
			send({ t: "models" });
			return;
		}
		send({ t: "set_model_query", query: args });
	},
	thinking(args) {
		if (!args) {
			send({ t: "thinking" });
			return;
		}
		send({ t: "set_thinking_query", query: args });
	},
	new() {
		send({ t: "new_session" });
	},
	resume() {
		location.hash = "";
	},
	quit() {
		quitSession();
	},
	tree() {
		send({ t: "tree" });
	},
	fork(args) {
		// With an id the fork runs directly; bare `/fork` opens the tree sheet to
		// pick a user message (the TUI picker).
		if (args) {
			send({ t: "fork", entryId: args });
			return;
		}
		send({ t: "tree" });
	},
	clone() {
		send({ t: "clone" });
	},
	import(args) {
		if (!args) {
			toast("usage: /import <path>");
			return;
		}
		send({ t: "import", path: args });
	},
	export() {
		send({ t: "export" });
	},
};

export function setAttachMenu(open) {
	ui.attachMenu.hidden = !open;
	ui.attach.setAttribute("aria-expanded", String(open));
}

export function clearPendingAttachment() {
	state.attachmentSeq += 1;
	state.pendingAttachment = null;
	renderAttachment();
}

export function removeAttachment() {
	clearPendingAttachment();
}

export function renderAttachment() {
	const attachment = state.pendingAttachment;
	ui.attachment.textContent = "";
	if (!attachment) {
		ui.attachment.hidden = true;
		refreshSendState();
		return;
	}
	ui.attachment.hidden = false;
	const card = document.createElement("div");
	card.className = "attachment-card";
	if (attachment.kind === "image") {
		const img = document.createElement("img");
		img.src = attachment.dataUrl;
		img.alt = "";
		card.append(img);
	} else {
		const icon = document.createElement("div");
		icon.className = "attachment-icon";
		icon.textContent = attachment.kind === "file" ? "file" : attachment.kind === "error" ? "!" : "…";
		card.append(icon);
	}
	const meta = document.createElement("div");
	meta.className = "attachment-meta";
	const name = document.createElement("span");
	name.className = "attachment-name";
	name.textContent = attachment.name;
	const sub = document.createElement("span");
	sub.className = "attachment-sub";
	if (attachment.kind === "image")
		sub.textContent = `${sizeLabel(attachment.size)} · ${attachment.width}×${attachment.height}`;
	else if (attachment.kind === "file")
		sub.textContent = `${sizeLabel(attachment.size)} · ${attachment.uploading ? "uploading…" : "ready"}`;
	else if (attachment.kind === "busy") sub.textContent = attachment.label;
	else {
		card.classList.add("error");
		sub.textContent = attachment.error;
	}
	meta.append(name, sub);
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "attachment-remove";
	remove.setAttribute("aria-label", "Remove attachment");
	remove.textContent = "×";
	remove.addEventListener("click", removeAttachment);
	card.append(meta, remove);
	ui.attachment.append(card);
	refreshSendState();
}

export async function chooseAttachment(file, imageSource) {
	const seq = ++state.attachmentSeq;
	if (imageSource || looksLikeImage(file)) {
		state.pendingAttachment = { kind: "busy", name: file.name || "image", size: file.size, label: "preparing image…" };
		renderAttachment();
		try {
			const prepared = await prepareImage(file);
			if (seq !== state.attachmentSeq) return;
			state.pendingAttachment = prepared;
			renderAttachment();
		} catch (error) {
			if (seq !== state.attachmentSeq) return;
			if (!imageSource) {
				// The generic picker may choose an image the browser cannot decode;
				// hand it to the file path instead of rejecting it outright.
				await uploadAttachment(file, seq);
				return;
			}
			state.pendingAttachment = { kind: "error", name: file.name || "image", error: error.message };
			renderAttachment();
		}
		return;
	}
	await uploadAttachment(file, seq);
}

export function loadImageFile(file) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("could not decode image"));
		};
		image.src = url;
	});
}

export function canvasToBlob(canvas, type, quality) {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function blobToBase64(blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

export async function prepareImage(file) {
	if (file.size > MAX_IMAGE_SOURCE_BYTES) {
		throw new Error(`image is ${sizeLabel(file.size)}; max 20 MB`);
	}
	const image = await loadImageFile(file);
	try {
		const sourceWidth = image.naturalWidth || image.width;
		const sourceHeight = image.naturalHeight || image.height;
		if (!sourceWidth || !sourceHeight) throw new Error("image has no dimensions");
		const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
		const width = Math.max(1, Math.round(sourceWidth * scale));
		const height = Math.max(1, Math.round(sourceHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("canvas is unavailable");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);
		const blob = (await canvasToBlob(canvas, "image/jpeg", 0.85)) ?? (await canvasToBlob(canvas, "image/png"));
		if (!blob) throw new Error("could not encode image");
		if (blob.size > MAX_IMAGE_BYTES) throw new Error(`encoded image is ${sizeLabel(blob.size)}; max 8 MB`);
		const data = await blobToBase64(blob);
		const mimeType = blob.type || "image/jpeg";
		return {
			kind: "image",
			name: file.name || "image",
			mimeType,
			data,
			dataUrl: `data:${mimeType};base64,${data}`,
			size: blob.size,
			width,
			height,
		};
	} finally {
		if (image.src.startsWith("blob:")) URL.revokeObjectURL(image.src);
	}
}

export async function uploadAttachment(file, seq) {
	if (file.size > MAX_UPLOAD_BYTES) {
		state.pendingAttachment = {
			kind: "error",
			name: file.name || "file",
			error: `file is ${sizeLabel(file.size)}; max 100 MB`,
		};
		renderAttachment();
		return;
	}
	if (!state.sessionId) {
		state.pendingAttachment = { kind: "error", name: file.name || "file", error: "no active session" };
		renderAttachment();
		return;
	}
	state.pendingAttachment = { kind: "file", name: file.name || "file", size: file.size, uploading: true };
	renderAttachment();
	try {
		const url = `/api/sessions/${encodeURIComponent(state.sessionId)}/uploads?name=${encodeURIComponent(file.name || "file")}`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": file.type || "application/octet-stream" },
			body: file,
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `upload failed (${response.status})`);
		if (seq !== state.attachmentSeq) return;
		state.pendingAttachment = {
			kind: "file",
			name: data.name ?? file.name ?? "file",
			size: Number(data.size) || file.size,
			path: String(data.path ?? ""),
			uploading: false,
		};
		renderAttachment();
	} catch (error) {
		if (seq !== state.attachmentSeq) return;
		state.pendingAttachment = { kind: "error", name: file.name || "file", error: error.message };
		renderAttachment();
	}
}

export function clearInput() {
	ui.input.value = "";
	closeMenu();
	resize();
	refreshSendState();
}

export function attachmentBlocksCommand(label) {
	if (!state.pendingAttachment) return false;
	notice(`remove or send the attachment before ${label}`);
	return true;
}

export function submit() {
	const text = ui.input.value.trim();
	const attachment = state.pendingAttachment;
	if (attachment?.kind === "busy" || (attachment?.kind === "file" && attachment.uploading)) {
		toast("attachment is still uploading");
		return;
	}
	if (attachment?.kind === "error") {
		toast("remove the failed attachment first");
		return;
	}
	if (!text && !attachment) return;
	if (!text) {
		submitText("", attachment);
		return;
	}
	const action = classifyInput(text);
	switch (action.kind) {
		case "empty":
			return;
		case "menu":
			// `/` opens the suggestion menu in 06-command-menu; keep the text until then.
			return;
		case "bash":
			if (attachmentBlocksCommand("running a bash command")) return;
			submitBash(action);
			return;
		case "tui":
			if (attachmentBlocksCommand("using a TUI command")) return;
			if (!allowed(action)) return;
			notice(
				`/${action.name} is a Pi TUI-only command${action.command?.ticket ? ` (planned in ${action.command.ticket})` : ""} — use a terminal`,
			);
			clearInput();
			return;
		case "builtin": {
			if (attachmentBlocksCommand("using a builtin command")) return;
			if (!allowed(action)) return;
			const handler = builtinHandlers[action.name];
			if (!handler) {
				notice(`/${action.name} is not wired yet`);
				clearInput();
				return;
			}
			handler(action.args);
			clearInput();
			return;
		}
		case "passthrough":
			// Unknown `/thing` and every extension command/template/skill go to Pi
			// verbatim. While busy that must be `prompt` + steer: RPC `steer` would
			// queue the text instead of executing the extension command.
			if (!allowed(action)) return;
			submitSlash(action.text, attachment);
			return;
		default:
			submitText(action.text, attachment);
	}
}

export function renderReplace(entries, more) {
	state.entries = [];
	state.more = false;
	state.stick = true;
	updateJump();
	renderSnapshot(entries, more);
}

export function applyPolicy(policy) {
	state.policy =
		policy && typeof policy === "object"
			? {
					allow: Array.isArray(policy.allow) ? policy.allow.filter((name) => typeof name === "string") : [],
					deny: Array.isArray(policy.deny) ? policy.deny.filter((name) => typeof name === "string") : [],
					bash: policy.bash !== false,
				}
			: null;
}

export function allowed(action) {
	if (isAllowed(action.name, state.policy)) return true;
	notice(`/${action.name} is blocked by the command policy`);
	clearInput();
	return false;
}

export function quitSession() {
	send({ t: "stop" });
	state.quitting = true;
	// The status frame normally navigates; this is the fallback if the socket
	// drops before it arrives.
	setTimeout(() => {
		if (!state.quitting) return;
		state.quitting = false;
		location.hash = "";
	}, 500);
}

export function submitSlash(text, attachment) {
	const busy = state.info?.state === "busy";
	const images =
		attachment?.kind === "image"
			? [{ type: "image", data: attachment.data, mimeType: attachment.mimeType }]
			: undefined;
	const outgoing = attachment?.kind === "file" && attachment.path ? attachmentPrompt(text, attachment.path) : text;
	send({ t: "prompt", text: outgoing, ...(busy ? { streamingBehavior: "steer" } : {}), ...(images ? { images } : {}) });
	// No optimistic user echo: an extension command may consume the prompt, and
	// Pi's own message_start paints templates/skills when they produce a message.
	clearInput();
	clearPendingAttachment();
}

export function submitText(text, attachment) {
	const busy = state.info?.state === "busy";
	const images =
		attachment?.kind === "image"
			? [{ type: "image", data: attachment.data, mimeType: attachment.mimeType }]
			: undefined;
	const outgoing = attachment?.kind === "file" && attachment.path ? attachmentPrompt(text, attachment.path) : text;
	send({ t: busy ? "steer" : "prompt", text: outgoing, ...(images ? { images } : {}) });
	const content = [];
	if (outgoing) content.push({ type: "text", text: outgoing });
	if (images) content.push(...images);
	state.pendingUser = appendBlock("user", `<div class="who">you</div>${renderUserBody({ content })}`, true);
	clearInput();
	clearPendingAttachment();
	scrollToEnd(true);
}

export let bashSeq = 0;

export function submitBash(action) {
	// `!`/`!!` with no command is a no-op (the TUI keeps the text for editing).
	if (!action.command) return;
	if (state.policy && state.policy.bash === false) {
		notice("bash is disabled by the command policy");
		clearInput();
		return;
	}
	if (state.bashRunning) {
		// TUI guard: one bash at a time; keep the text so it can be resubmitted.
		toast("a bash command is already running");
		return;
	}
	const id = `b${++bashSeq}-${Date.now().toString(36)}`;
	state.bashRunning = true;
	state.bash.set(id, appendBashCard(id, action.command, action.excludeFromContext));
	send({ t: "bash", id, command: action.command, excludeFromContext: action.excludeFromContext });
	clearInput();
	scrollToEnd(true);
}

export function appendBashCard(id, command, excluded) {
	const host = document.createElement("div");
	host.innerHTML = bashCardHtml({
		command,
		output: "",
		exitCode: null,
		cancelled: false,
		truncated: false,
		excludeFromContext: excluded,
		running: true,
	});
	const card = host.firstElementChild;
	if (!card) return ui.log.appendChild(document.createElement("div"));
	card.dataset.bash = id;
	ui.log.append(card);
	scheduleScroll();
	return card;
}

export function finishBash(frame) {
	state.bashRunning = false;
	const card = state.bash.get(frame.id);
	state.bash.delete(frame.id);
	if (!card) {
		if (frame.error) toast(frame.error);
		return;
	}
	if (frame.error) {
		card.classList.remove("running");
		card.classList.add("error");
		const meta = card.querySelector(".bash-meta");
		if (meta) meta.textContent = `failed: ${frame.error}`;
		scrollToEnd();
		return;
	}
	card.insertAdjacentHTML("beforebegin", bashCardHtml(frame));
	card.remove();
	scrollToEnd();
}

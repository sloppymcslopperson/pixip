// Attachment surface: choose/render/prepare/upload lifecycle. Encoding math and
// validation live in the pure attachments.js engine.
import {
	IMAGE_ENCODE_ATTEMPTS,
	fitImage,
	imageSourceError,
	looksLikeImage,
	sizeLabel,
	uploadError,
} from "./attachments.js";
import { refreshSendState } from "./sendState.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

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
	const rejected = imageSourceError(file);
	if (rejected) throw new Error(rejected);
	const image = await loadImageFile(file);
	try {
		const { width, height } = fitImage(image.naturalWidth || image.width, image.naturalHeight || image.height);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("canvas is unavailable");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);
		let blob = null;
		for (const attempt of IMAGE_ENCODE_ATTEMPTS) {
			blob = await canvasToBlob(canvas, attempt.type, attempt.quality);
			if (blob) break;
		}
		if (!blob) throw new Error("could not encode image");
		if (blob.size > 8 * 1024 * 1024) throw new Error(`encoded image is ${sizeLabel(blob.size)}; max 8 MB`);
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
	const rejected = uploadError(file, state.sessionId);
	if (rejected) {
		state.pendingAttachment = { kind: "error", name: file.name || "file", error: rejected };
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

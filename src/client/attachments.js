// Pure attachment helpers: limits and prompt shaping live here so node --test
// can cover them without a DOM.

/** Hard client ceiling for the original file before any image downscale. */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
/** Longest edge after canvas downscale. */
export const MAX_IMAGE_EDGE = 1600;
/** Hub-side cap for the encoded image payload. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Raw body cap for a non-image upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const IMAGE_EXTENSION = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;

export function sizeLabel(bytes) {
	const value = Number(bytes) || 0;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** The exact text Pi receives for a non-image attachment. */
export function attachmentPrompt(text, path) {
	const body = String(text ?? "").trim();
	return body ? `${body}\n\nAttached file: ${path}` : `Attached file: ${path}`;
}

/** A file picker may hand us a decodable image under any name/MIME. */
export function looksLikeImage(file) {
	const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
	if (type.startsWith("image/")) return true;
	return IMAGE_EXTENSION.test(typeof file?.name === "string" ? file.name : "");
}

/** Downscale plan for an image: longest edge capped, never upscaled. */
export function fitImage(sourceWidth, sourceHeight, maxEdge = MAX_IMAGE_EDGE) {
	if (!sourceWidth || !sourceHeight) throw new Error("image has no dimensions");
	const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
	return {
		width: Math.max(1, Math.round(sourceWidth * scale)),
		height: Math.max(1, Math.round(sourceHeight * scale)),
		scale,
	};
}

/** Encode preference: JPEG first, PNG when the browser cannot encode JPEG. */
export const IMAGE_ENCODE_ATTEMPTS = [
	{ type: "image/jpeg", quality: 0.85 },
	{ type: "image/png", quality: undefined },
];

/** Rejection message for the original image before any downscale. */
export function imageSourceError(file) {
	if (file.size > MAX_IMAGE_SOURCE_BYTES) return `image is ${sizeLabel(file.size)}; max 20 MB`;
	return null;
}

/** Rejection message for a non-image upload. */
export function uploadError(file, sessionId) {
	if (file.size > MAX_UPLOAD_BYTES) return `file is ${sizeLabel(file.size)}; max 100 MB`;
	if (!sessionId) return "no active session";
	return null;
}

/** The text Pi receives, with a non-image attachment path appended once. */
export function outgoingText(text, attachment) {
	return attachment?.kind === "file" && attachment.path ? attachmentPrompt(text, attachment.path) : text;
}

/** Image content blocks for a prompt/steer frame, if any. */
export function imageBlocks(attachment) {
	if (attachment?.kind !== "image") return undefined;
	return [{ type: "image", data: attachment.data, mimeType: attachment.mimeType }];
}

/** Payload for an unknown/extension slash command. */
export function slashPayload(text, attachment, busy) {
	const images = imageBlocks(attachment);
	return {
		t: "prompt",
		text: outgoingText(text, attachment),
		...(busy ? { streamingBehavior: "steer" } : {}),
		...(images ? { images } : {}),
	};
}

/** Payload for typed text: steer while busy, prompt when idle. */
export function textPayload(text, attachment, busy) {
	const images = imageBlocks(attachment);
	return {
		t: busy ? "steer" : "prompt",
		text: outgoingText(text, attachment),
		...(images ? { images } : {}),
	};
}

/** Optimistic user block content, matching what Pi will echo. */
export function optimisticContent(text, attachment) {
	const outgoing = outgoingText(text, attachment);
	const images = imageBlocks(attachment);
	const content = [];
	if (outgoing) content.push({ type: "text", text: outgoing });
	if (images) content.push(...images);
	return content;
}

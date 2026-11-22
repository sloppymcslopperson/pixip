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

/**
 * Attachment limits shared by the hub and the HTTP upload route.
 *
 * Images travel as Pi `ImageContent` on the RPC prompt/steer command, so the hub
 * validates them before they reach a child. Non-image files are written under
 * `<data-dir>/uploads/<logical-session>/` and only their path enters the prompt.
 */
import { basename } from "node:path";

export interface ImageAttachment {
	type: "image";
	/** Base64, no data-URL prefix. */
	data: string;
	mimeType: string;
}

/** Pi downscales to ~4.5 MB; this is the hub's independent safety ceiling. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Base64 expansion of `MAX_IMAGE_BYTES`, with headroom for padding. */
export const MAX_IMAGE_BASE64_CHARS = 11 * 1024 * 1024;
/** Raw body cap for the arbitrary-file upload endpoint. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Magic-byte detection for the download route, which never trusts a filename. */
export function detectImageMime(bytes: Uint8Array): string | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6) {
		const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
		if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	}
	if (bytes.length >= 12) {
		const riff = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
		const webp = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
		if (riff === "RIFF" && webp === "WEBP") return "image/webp";
	}
	return undefined;
}

function supportedMimeType(value: string): string | undefined {
	const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
	if (base === "image/jpg") return "image/jpeg";
	return SUPPORTED_IMAGE_MIME.has(base) ? base : undefined;
}

/**
 * Validate a wire `images` value and return the normalized ImageContent array.
 * An absent value is no images. Anything malformed is a hard error so the
 * server can report it instead of silently sending a text-only prompt.
 */
export function normalizeImageAttachments(raw: unknown): ImageAttachment[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("images must be an array");
	if (raw.length > 1) throw new Error("only one image attachment is supported");
	return raw.map((item, index) => {
		if (!item || typeof item !== "object") throw new Error(`image ${index + 1} is not an object`);
		const image = item as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (image.type !== "image") throw new Error(`image ${index + 1} must have type "image"`);
		if (typeof image.mimeType !== "string") throw new Error(`image ${index + 1} has no mimeType`);
		const mimeType = supportedMimeType(image.mimeType);
		if (!mimeType) throw new Error(`unsupported image type "${image.mimeType}"`);
		if (typeof image.data !== "string" || image.data.length === 0) {
			throw new Error(`image ${index + 1} has no data`);
		}
		if (image.data.length > MAX_IMAGE_BASE64_CHARS) throw new Error("image is too large");
		if (image.data.length % 4 !== 0 || !BASE64.test(image.data)) {
			throw new Error(`image ${index + 1} is not valid base64`);
		}
		const bytes = Buffer.from(image.data, "base64");
		if (bytes.byteLength === 0) throw new Error(`image ${index + 1} has no data`);
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("image is too large");
		return { type: "image", data: image.data, mimeType };
	});
}

/** A filename that is safe as one path component and keeps its extension. */
export function safeUploadName(name: string): string {
	const base = basename(String(name || "file"))
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^\.+$/, "file");
	return base.slice(0, 100) || "file";
}

/**
 * Core of `show_image_to_user`.
 *
 * The tool exists so the agent can deliberately show one local image to the
 * user. It is separate from `read`: pixip renders image blocks only for this
 * tool, so an incidental image in another tool result stays text-only.
 *
 * Size policy:
 * - up to 1 MB: return the original image;
 * - over 1 MB, up to 20 MB: return a thumbnail (longest edge 1024 px, at most
 *   512 KB) and tell the user the original is over the limit with a link;
 * - over 20 MB: no read, link only;
 * - a failed thumbnail resize: link only.
 *
 * Pi normalizes tool-result images again before they enter session history, so
 * this policy is about intentional display payloads, not provider limits.
 */
import { stat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const SHOW_IMAGE_TOOL = "show_image_to_user";

/** A source at or below this stays untouched. */
export const MAX_SOURCE_BYTES = 1024 * 1024;
/** Above this the file is not read at all; the user gets a link. */
export const MAX_READ_BYTES = 20 * 1024 * 1024;
export const THUMB_MAX_EDGE = 1024;
export const THUMB_MAX_BYTES = 512 * 1024;

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ShowImageDetails {
	/** Absolute source path. */
	path: string;
	caption?: string;
	/** Size of the source file in bytes. */
	bytes: number;
	/** True when the returned image is a generated thumbnail. */
	thumbnail: boolean;
	/** Source was over MAX_SOURCE_BYTES. */
	overSourceLimit: boolean;
	/** Source was over MAX_READ_BYTES; no image was returned. */
	tooLarge: boolean;
}

export interface ShowImageResult {
	content: Array<TextContent | ImageContent>;
	details: ShowImageDetails;
}

export interface ResizedThumbnail {
	data: string;
	mimeType: string;
	width: number;
	height: number;
}

export interface ShowImageDeps {
	stat: (path: string) => Promise<{ isFile: () => boolean; size: number }>;
	readFile: (path: string) => Promise<Uint8Array>;
	detectMime: (path: string) => Promise<string | null | undefined>;
	resize: (bytes: Uint8Array, mimeType: string) => Promise<ResizedThumbnail | null>;
}

export const showImageDeps: ShowImageDeps = {
	stat,
	readFile,
	detectMime: async (path) => {
		const { detectSupportedImageMimeTypeFromFile } = await import("@earendil-works/pi-coding-agent");
		return await detectSupportedImageMimeTypeFromFile(path);
	},
	resize: async (bytes, mimeType) => {
		const { resizeImage } = await import("@earendil-works/pi-coding-agent");
		const resized = await resizeImage(bytes, mimeType, {
			maxWidth: THUMB_MAX_EDGE,
			maxHeight: THUMB_MAX_EDGE,
			maxBytes: THUMB_MAX_BYTES,
		});
		return resized
			? { data: resized.data, mimeType: resized.mimeType, width: resized.width, height: resized.height }
			: null;
	},
};

function sizeLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / (1024 * 1024);
	return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
}

/** A markdown link Pi's TUI and other hosts can show; pixip rewrites it. */
export function fileLink(path: string): string {
	const url = pathToFileURL(path).href;
	return `[${url}](${url})`;
}

function textFor(details: ShowImageDetails, dimensions?: { width: number; height: number }): string {
	const lines: string[] = [];
	if (details.caption) lines.push(details.caption);
	if (details.tooLarge) {
		lines.push(
			`File is ${sizeLabel(details.bytes)}, over the ${sizeLabel(MAX_READ_BYTES)} limit; showing a link only.`,
		);
	} else if (details.thumbnail && dimensions) {
		lines.push(
			`File is ${sizeLabel(details.bytes)}, over the ${sizeLabel(MAX_SOURCE_BYTES)} limit; ` +
				`showing a ${dimensions.width}×${dimensions.height} thumbnail.`,
		);
	} else if (details.overSourceLimit) {
		lines.push(
			`File is ${sizeLabel(details.bytes)}, over the ${sizeLabel(MAX_SOURCE_BYTES)} limit; ` +
				"a thumbnail could not be made.",
		);
	}
	lines.push(`Download: ${fileLink(details.path)}`);
	return lines.join("\n");
}

export class ShowImageError extends Error {}

export interface ShowImageInput {
	path: string;
	caption?: string;
}

/**
 * Validate one request and build the tool result. Errors are thrown: Pi turns
 * them into an error tool result the agent can read and correct.
 */
export async function showImageToUser(
	input: ShowImageInput,
	deps: ShowImageDeps = showImageDeps,
): Promise<ShowImageResult> {
	const path = typeof input.path === "string" ? input.path.trim() : "";
	if (!path) throw new ShowImageError("path is required");
	if (!isAbsolute(path)) {
		throw new ShowImageError(`path must be absolute (got "${path}"); pass the full path to the image`);
	}
	const caption = typeof input.caption === "string" ? input.caption.trim() : "";

	let info: { isFile: () => boolean; size: number };
	try {
		info = await deps.stat(path);
	} catch (error) {
		throw new ShowImageError(`cannot read ${path}: ${(error as Error).message}`);
	}
	if (!info.isFile()) throw new ShowImageError(`${path} is not a regular file`);

	const mimeType = await deps.detectMime(path);
	if (!mimeType) throw new ShowImageError(`${path} is not a supported image (PNG, JPEG, GIF or WebP)`);

	const details: ShowImageDetails = {
		path,
		bytes: info.size,
		thumbnail: false,
		overSourceLimit: info.size > MAX_SOURCE_BYTES,
		tooLarge: info.size > MAX_READ_BYTES,
		...(caption ? { caption } : {}),
	};
	if (details.tooLarge) {
		return { content: [{ type: "text", text: textFor(details) }], details };
	}

	let bytes: Uint8Array;
	try {
		bytes = await deps.readFile(path);
	} catch (error) {
		throw new ShowImageError(`cannot read ${path}: ${(error as Error).message}`);
	}

	if (!details.overSourceLimit) {
		return {
			content: [
				{ type: "text", text: textFor(details) },
				{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
			],
			details,
		};
	}

	let thumbnail: ResizedThumbnail | null = null;
	try {
		thumbnail = await deps.resize(bytes, mimeType);
	} catch {
		thumbnail = null;
	}
	if (!thumbnail) {
		return { content: [{ type: "text", text: textFor(details) }], details };
	}
	details.thumbnail = true;
	return {
		content: [
			{
				type: "text",
				text: textFor(details, { width: thumbnail.width, height: thumbnail.height }),
			},
			{ type: "image", data: thumbnail.data, mimeType: thumbnail.mimeType },
		],
		details,
	};
}

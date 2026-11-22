import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_IMAGE_SOURCE_BYTES,
	MAX_UPLOAD_BYTES,
	attachmentPrompt,
	looksLikeImage,
	sizeLabel,
} from "../src/client/attachments.js";

describe("client attachment limits", () => {
	it("uses the agreed image and file caps", () => {
		assert.equal(MAX_IMAGE_SOURCE_BYTES, 20 * 1024 * 1024);
		assert.equal(MAX_IMAGE_EDGE, 1600);
		assert.equal(MAX_IMAGE_BYTES, 8 * 1024 * 1024);
		assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
	});

	it("formats sizes for the inline chip", () => {
		assert.equal(sizeLabel(512), "512 B");
		assert.equal(sizeLabel(1536), "1.5 KB");
		assert.equal(sizeLabel(1024 * 1024), "1.0 MB");
	});
});

describe("attachment prompt shaping", () => {
	it("appends one path line after the typed text", () => {
		assert.equal(attachmentPrompt("describe this", "/tmp/a b.txt"), "describe this\n\nAttached file: /tmp/a b.txt");
	});

	it("uses only the path for an attachment-only prompt", () => {
		assert.equal(attachmentPrompt("   ", "/tmp/a.txt"), "Attached file: /tmp/a.txt");
	});
});

describe("image detection", () => {
	it("treats image MIME types and image filenames as images", () => {
		assert.equal(looksLikeImage({ type: "image/png", name: "x" }), true);
		assert.equal(looksLikeImage({ type: "", name: "photo.HEIC" }), true);
		assert.equal(looksLikeImage({ type: "application/pdf", name: "doc.pdf" }), false);
	});
});

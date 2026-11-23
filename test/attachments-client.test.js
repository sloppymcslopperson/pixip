import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	IMAGE_ENCODE_ATTEMPTS,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_IMAGE_SOURCE_BYTES,
	MAX_UPLOAD_BYTES,
	attachmentPrompt,
	fitImage,
	imageBlocks,
	imageSourceError,
	looksLikeImage,
	optimisticContent,
	outgoingText,
	sizeLabel,
	slashPayload,
	textPayload,
	uploadError,
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

describe("image downscale math", () => {
	it("caps the longest edge and never upscales", () => {
		assert.deepEqual(fitImage(4000, 2000), { width: 1600, height: 800, scale: 0.4 });
		assert.deepEqual(fitImage(800, 400), { width: 800, height: 400, scale: 1 });
		assert.deepEqual(fitImage(100, 300), { width: 100, height: 300, scale: 1 });
	});

	it("rejects images with no dimensions", () => {
		assert.throws(() => fitImage(0, 100), /no dimensions/);
		assert.throws(() => fitImage(100, 0), /no dimensions/);
	});

	it("prefers jpeg and falls back to png", () => {
		assert.deepEqual(
			IMAGE_ENCODE_ATTEMPTS.map((attempt) => attempt.type),
			["image/jpeg", "image/png"],
		);
		assert.equal(IMAGE_ENCODE_ATTEMPTS[0].quality, 0.85);
	});
});

describe("attachment validation", () => {
	it("rejects oversized source images before decoding", () => {
		assert.equal(imageSourceError({ size: MAX_IMAGE_SOURCE_BYTES }), null);
		assert.match(imageSourceError({ size: MAX_IMAGE_SOURCE_BYTES + 1 }), /max 20 MB/);
	});

	it("rejects oversized uploads and uploads without a session", () => {
		assert.equal(uploadError({ size: 10 }, "s1"), null);
		assert.match(uploadError({ size: MAX_UPLOAD_BYTES + 1 }, "s1"), /max 100 MB/);
		assert.equal(uploadError({ size: 10 }, null), "no active session");
	});
});

describe("outgoing payload shaping", () => {
	const image = { kind: "image", data: "aGk=", mimeType: "image/png" };
	const file = { kind: "file", path: "/tmp/a b.txt" };

	it("appends a file path but leaves image text alone", () => {
		assert.equal(outgoingText("look", file), "look\n\nAttached file: /tmp/a b.txt");
		assert.equal(outgoingText("look", image), "look");
		assert.equal(outgoingText("look", null), "look");
	});

	it("builds image blocks only for images", () => {
		assert.deepEqual(imageBlocks(image), [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		assert.equal(imageBlocks(file), undefined);
	});

	it("shapes slash payloads as prompt plus steer while busy", () => {
		assert.deepEqual(slashPayload("run", image, false), {
			t: "prompt",
			text: "run",
			images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		});
		assert.deepEqual(slashPayload("run", null, true), {
			t: "prompt",
			text: "run",
			streamingBehavior: "steer",
		});
	});

	it("shapes text payloads as steer while busy and prompt when idle", () => {
		assert.deepEqual(textPayload("hi", file, false), {
			t: "prompt",
			text: "hi\n\nAttached file: /tmp/a b.txt",
		});
		assert.deepEqual(textPayload("hi", null, true), { t: "steer", text: "hi" });
	});

	it("builds the optimistic user content from the same text and images", () => {
		assert.deepEqual(optimisticContent("look", image), [
			{ type: "text", text: "look" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
		assert.deepEqual(optimisticContent("look", file), [{ type: "text", text: "look\n\nAttached file: /tmp/a b.txt" }]);
		assert.deepEqual(optimisticContent("", null), []);
	});
});

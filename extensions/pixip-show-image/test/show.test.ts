import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_READ_BYTES, MAX_SOURCE_BYTES, type ShowImageDeps, ShowImageError, showImageToUser } from "../src/show.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PATH = "/tmp/shot.png";

function deps(overrides: Partial<ShowImageDeps> = {}): ShowImageDeps & { calls: { resized: number; read: number } } {
	const calls = { resized: 0, read: 0 };
	const base: ShowImageDeps = {
		stat: async () => ({ isFile: () => true, size: PNG.byteLength }),
		readFile: async () => {
			calls.read += 1;
			return PNG;
		},
		detectMime: async () => "image/png",
		resize: async () => {
			calls.resized += 1;
			return { data: Buffer.from("thumb").toString("base64"), mimeType: "image/jpeg", width: 1024, height: 512 };
		},
	};
	return { ...base, ...overrides, calls };
}

describe("showImageToUser", () => {
	it("requires an absolute path", async () => {
		await assert.rejects(showImageToUser({ path: "shot.png" }, deps()), ShowImageError);
		await assert.rejects(showImageToUser({ path: "shot.png" }, deps()), /absolute/);
		await assert.rejects(showImageToUser({ path: "" }, deps()), /required/);
	});

	it("rejects missing, non-file and unsupported sources", async () => {
		await assert.rejects(
			showImageToUser(
				{ path: PATH },
				deps({
					stat: async () => {
						throw new Error("ENOENT");
					},
				}),
			),
			/cannot read/,
		);
		await assert.rejects(
			showImageToUser({ path: PATH }, deps({ stat: async () => ({ isFile: () => false, size: 10 }) })),
			/not a regular file/,
		);
		await assert.rejects(showImageToUser({ path: PATH }, deps({ detectMime: async () => null })), /not a supported/);
	});

	it("returns a small image unchanged with the caption and link", async () => {
		const result = await showImageToUser({ path: PATH, caption: "Login screen" }, deps());
		assert.equal(result.details.thumbnail, false);
		assert.equal(result.details.overSourceLimit, false);
		assert.equal(result.details.tooLarge, false);
		assert.equal(result.content.length, 2);
		const [text, image] = result.content;
		assert.equal(text?.type, "text");
		assert.match(text?.type === "text" ? text.text : "", /^Login screen\nDownload: \[file:\/\/\/tmp\/shot\.png\]/);
		assert.deepEqual(image, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
	});

	it("downscales an over-limit source and explains the thumbnail", async () => {
		const fake = deps({
			stat: async () => ({ isFile: () => true, size: MAX_SOURCE_BYTES + 1 }),
		});
		const result = await showImageToUser({ path: PATH }, fake);
		assert.equal(fake.calls.resized, 1);
		assert.equal(fake.calls.read, 1);
		assert.equal(result.details.thumbnail, true);
		assert.equal(result.details.overSourceLimit, true);
		assert.equal(result.content.length, 2);
		const [text, image] = result.content;
		assert.match(text?.type === "text" ? text.text : "", /over the 1 MB limit/);
		assert.match(text?.type === "text" ? text.text : "", /1024×512 thumbnail/);
		assert.deepEqual(image, { type: "image", data: Buffer.from("thumb").toString("base64"), mimeType: "image/jpeg" });
	});

	it("falls back to the link when a thumbnail cannot be made", async () => {
		const fake = deps({
			stat: async () => ({ isFile: () => true, size: MAX_SOURCE_BYTES + 1 }),
			resize: async () => null,
		});
		const result = await showImageToUser({ path: PATH }, fake);
		assert.equal(result.content.length, 1);
		assert.equal(result.details.thumbnail, false);
		const text = result.content[0];
		assert.match(text?.type === "text" ? text.text : "", /thumbnail could not be made/);
		assert.match(text?.type === "text" ? text.text : "", /file:\/\/\/tmp\/shot\.png/);
	});

	it("does not read a source over the hard cap", async () => {
		const fake = deps({
			stat: async () => ({ isFile: () => true, size: MAX_READ_BYTES + 1 }),
		});
		const result = await showImageToUser({ path: PATH }, fake);
		assert.equal(fake.calls.read, 0);
		assert.equal(fake.calls.resized, 0);
		assert.equal(result.details.tooLarge, true);
		assert.equal(result.content.length, 1);
		const text = result.content[0];
		assert.match(text?.type === "text" ? text.text : "", /over the 20 MB limit/);
		assert.match(text?.type === "text" ? text.text : "", /showing a link only/);
	});
});

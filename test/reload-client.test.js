import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reloadNoticeKey, rememberReloadNotice, takeReloadNotice } from "../src/client/reloadModel.js";

class FakeStorage {
	constructor() {
		this.map = new Map();
	}
	getItem(key) {
		return this.map.get(key) ?? null;
	}
	setItem(key, value) {
		this.map.set(key, String(value));
	}
	removeItem(key) {
		this.map.delete(key);
	}
}

describe("reload notice persistence", () => {
	it("keeps one notice across the forced page reload and consumes it once", () => {
		const storage = new FakeStorage();
		rememberReloadNotice(storage, "s1", "reloaded assets");
		assert.equal(storage.getItem(reloadNoticeKey("s1")), "reloaded assets");
		assert.equal(takeReloadNotice(storage, "s1"), "reloaded assets");
		assert.equal(takeReloadNotice(storage, "s1"), null);
	});

	it("survives storage failures without throwing", () => {
		const broken = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("blocked");
			},
			removeItem() {
				throw new Error("blocked");
			},
		};
		assert.doesNotThrow(() => rememberReloadNotice(broken, "s1", "x"));
		assert.equal(takeReloadNotice(broken, "s1"), null);
	});
});

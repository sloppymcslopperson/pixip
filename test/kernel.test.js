import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const storage = new Map([
	["pixip.sessionGroups.collapsed", JSON.stringify({ "/tmp/project": true })],
	["pixip.sessionGroups.keepActive", "false"],
]);

before(() => {
	globalThis.window = {
		matchMedia: (query) => ({ matches: query === "(pointer: coarse)" }),
	};
	globalThis.localStorage = {
		getItem: (key) => storage.get(key) ?? null,
		setItem: (key, value) => storage.set(key, String(value)),
	};
});

after(() => {
	globalThis.window = originalWindow;
	globalThis.document = originalDocument;
	globalThis.localStorage = originalLocalStorage;
});

describe("kernel state initialization", () => {
	it("builds the flat container from the device-local initializers", async () => {
		const { state } = await import("../src/client/kernel/state.js");
		assert.equal(state.sessionId, null);
		assert.deepEqual(state.entries, []);
		assert.deepEqual(state.collapsed, { "/tmp/project": true });
		assert.equal(state.keepActive, false);
		assert.equal(state.coarse, true);
		assert.equal(state.sessionCache.size, 0);
		assert.deepEqual(state.addon.statuses, new Map());
		assert.deepEqual(state.addon.widgets, new Map());
	});

	it("falls back safely when storage throws", async () => {
		const { readCollapsedGroups, readKeepActive } = await import("../src/client/kernel/state.js");
		globalThis.localStorage = {
			getItem() {
				throw new Error("blocked");
			},
		};
		try {
			assert.deepEqual(readCollapsedGroups(), {});
			assert.equal(readKeepActive(), true);
		} finally {
			globalThis.localStorage = {
				getItem: (key) => storage.get(key) ?? null,
				setItem: (key, value) => storage.set(key, String(value)),
			};
		}
	});
});

describe("kernel ui map", () => {
	it("queries the static shell once and keeps the existing keys", async () => {
		const selectors = [];
		globalThis.document = {
			querySelector(selector) {
				selectors.push(selector);
				return { selector };
			},
		};
		const { $, ui } = await import("../src/client/kernel/ui.js");
		assert.deepEqual($("#probe"), { selector: "#probe" });
		assert.deepEqual(ui.bar, { selector: "#bar" });
		assert.deepEqual(ui.footerAbove, { selector: "#footer .addon-widgets.above" });
		assert.deepEqual(ui.surface, { selector: "#surface" });
		assert.deepEqual(ui.toast, { selector: "#toast" });
		assert.deepEqual(ui.inboxBar, { selector: "#inbox-bar" });
		assert.deepEqual(ui.inboxBarSubject, { selector: "#inbox-bar-subject" });
		assert.deepEqual(ui.inboxBarPreview, { selector: "#inbox-bar-preview" });
		assert.deepEqual(ui.inboxBadge, { selector: "#inbox-badge" });
		assert.deepEqual(ui.inboxPage, { selector: "#inbox-page" });
		assert.deepEqual(ui.reftagChips, { selector: "#reftag-chips" });
		assert.equal(Object.keys(ui).length, 41);
		assert.equal(selectors.filter((selector) => selector === "#bar").length, 1);
	});
});

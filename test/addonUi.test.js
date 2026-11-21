import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addonStatusText, addonWidgets, applyAddonUi, createAddonUi } from "../src/client/addonUi.js";

describe("addon UI state", () => {
	it("keeps status entries in first-seen order and updates in place", () => {
		const state = createAddonUi();
		applyAddonUi(state, { method: "setStatus", statusKey: "alpha", statusText: "first" });
		applyAddonUi(state, { method: "setStatus", statusKey: "beta", statusText: "second" });
		applyAddonUi(state, { method: "setStatus", statusKey: "alpha", statusText: "updated" });
		assert.equal(addonStatusText(state), "updated · second");
	});

	it("clears a status by key on an empty or missing value", () => {
		const state = createAddonUi();
		applyAddonUi(state, { method: "setStatus", statusKey: "alpha", statusText: "first" });
		applyAddonUi(state, { method: "setStatus", statusKey: "beta", statusText: "second" });
		applyAddonUi(state, { method: "setStatus", statusKey: "alpha", statusText: "" });
		applyAddonUi(state, { method: "setStatus", statusKey: "beta" });
		assert.equal(addonStatusText(state), "");
	});

	it("tracks widgets by placement, preserves first-seen order and clears", () => {
		const state = createAddonUi();
		applyAddonUi(state, { method: "setWidget", widgetKey: "a", widgetLines: ["a1", "a2"] });
		applyAddonUi(state, { method: "setWidget", widgetKey: "b", widgetLines: ["b1"], widgetPlacement: "belowEditor" });
		applyAddonUi(state, { method: "setWidget", widgetKey: "c", widgetLines: ["c1"] });
		applyAddonUi(state, { method: "setWidget", widgetKey: "a", widgetLines: ["a-updated"] });
		assert.deepEqual(addonWidgets(state, "above"), [
			{ key: "a", lines: ["a-updated"] },
			{ key: "c", lines: ["c1"] },
		]);
		assert.deepEqual(addonWidgets(state, "below"), [{ key: "b", lines: ["b1"] }]);
		applyAddonUi(state, { method: "setWidget", widgetKey: "b", widgetLines: [] });
		assert.deepEqual(addonWidgets(state, "below"), []);
	});

	it("ignores unknown methods, missing keys and non-string lines", () => {
		const state = createAddonUi();
		assert.equal(applyAddonUi(state, { method: "setTitle", title: "x" }), false);
		assert.equal(applyAddonUi(state, { method: "setStatus", statusText: "orphan" }), false);
		assert.equal(applyAddonUi(state, { method: "setWidget", widgetKey: "a", widgetLines: [1, "ok", null] }), true);
		assert.deepEqual(addonWidgets(state, "above"), [{ key: "a", lines: ["ok"] }]);
	});
});

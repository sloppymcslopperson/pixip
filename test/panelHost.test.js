import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	hasPanelRenderer,
	panelMode,
	panelTitle,
	registerPanelRenderer,
	selectPanelRenderer,
} from "../src/client/panelHost.js";

describe("panel host", () => {
	it("uses payload title/mode with safe defaults", () => {
		assert.equal(panelTitle({ title: "Review" }), "Review");
		assert.equal(panelTitle({ title: "   " }), "Extension panel");
		assert.equal(panelTitle(undefined), "Extension panel");
		assert.equal(panelMode({ mode: "a2ui" }), "a2ui");
		assert.equal(panelMode({}), "inline");
	});

	it("registers a renderer and only claims its declared modes", () => {
		const unregister = registerPanelRenderer({ modes: ["a2ui"], mount: () => ({}) });
		assert.equal(hasPanelRenderer("a2ui"), true);
		assert.equal(hasPanelRenderer("inline"), false);
		assert.equal(selectPanelRenderer("a2ui")?.modes?.[0], "a2ui");
		unregister();
		assert.equal(hasPanelRenderer("a2ui"), false);
	});

	it("accepts a bare mount function and rejects an unusable renderer", () => {
		const unregister = registerPanelRenderer(() => ({}));
		assert.equal(hasPanelRenderer("anything"), true);
		unregister();
		assert.throws(() => registerPanelRenderer({}), /mount/);
	});
});

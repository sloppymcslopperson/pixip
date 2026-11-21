import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contextLevel, footerPwdLine, footerStatsLeft, footerStatsRight, formatCwd, formatTokens } from "../src/client/footer.js";

const base = {
	cwd: "/home/sloppy/dev/sin",
	home: "/home/sloppy",
	branch: "master",
	name: "Tatars",
	tokens: { input: 13_400, output: 2_000, cacheRead: 38_000, cacheWrite: 0 },
	cost: 0.0034,
	context: { percent: 1.44, window: 1_000_000 },
	autoCompact: true,
	model: { id: "claude-haiku-5-5", provider: "opencode-go", reasoning: true },
	thinking: "high",
	providerCount: 1,
};

describe("footer formatting (TUI parity)", () => {
	it("formats token counts like the TUI footer", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1340), "1.3k");
		assert.equal(formatTokens(13_400), "13k");
		assert.equal(formatTokens(1_000_000), "1.0M");
	});

	it("abbreviates the home directory", () => {
		assert.equal(formatCwd("/home/sloppy/dev/sin", "/home/sloppy"), "~/dev/sin");
		assert.equal(formatCwd("/home/sloppy", "/home/sloppy"), "~");
		assert.equal(formatCwd("/etc", "/home/sloppy"), "/etc");
	});

	it("renders pwd line with branch and session name", () => {
		assert.equal(footerPwdLine(base), "~/dev/sin (master) • Tatars");
		assert.equal(footerPwdLine({ ...base, branch: undefined, name: undefined }), "~/dev/sin");
	});

	it("renders the stats line in TUI order", () => {
		assert.equal(footerStatsLeft(base), "↑13k ↓2.0k R38k $0.003 1.4%/1.0M (auto)");
		assert.equal(footerStatsRight(base), "claude-haiku-5-5 • high");
	});

	it("marks thinking off explicitly", () => {
		assert.equal(footerStatsRight({ ...base, thinking: "off" }), "claude-haiku-5-5 • thinking off");
	});

	it("omits thinking for non-reasoning models", () => {
		assert.equal(footerStatsRight({ ...base, model: { ...base.model, reasoning: false } }), "claude-haiku-5-5");
	});

	it("colors context by threshold", () => {
		assert.equal(contextLevel({ ...base, context: { percent: 42, window: 1000 } }), "ok");
		assert.equal(contextLevel({ ...base, context: { percent: 71, window: 1000 } }), "warning");
		assert.equal(contextLevel({ ...base, context: { percent: 91, window: 1000 } }), "error");
		assert.equal(contextLevel({ ...base, context: { percent: null, window: 1000 } }), "none");
	});
});

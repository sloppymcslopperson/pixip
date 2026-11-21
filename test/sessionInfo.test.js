import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSession } from "../src/client/sessionInfo.js";

const info = {
	id: "pi-id",
	logicalId: "logical-id",
	file: undefined,
	sessionFile: "/data/sessions/pi-id.jsonl",
	name: "dogfood",
	messageCount: 12,
	model: "stale-model",
	thinkingLevel: "low",
};

const footer = {
	cwd: "/home/x/project",
	home: "/home/x",
	tokens: { input: 1200, output: 345, cacheRead: 6789, cacheWrite: 12 },
	cost: 0.0456,
	context: { percent: 12.34, window: 100_000 },
	autoCompact: true,
	model: { id: "gpt-5", provider: "openai", reasoning: true },
	thinking: "high",
	providerCount: 0,
};

describe("formatSession", () => {
	it("renders the hub's existing session and footer data", () => {
		const text = formatSession(info, footer);
		assert.match(text, /^id\s+pi-id$/m);
		assert.match(text, /^logical\s+logical-id$/m);
		assert.match(text, /^name\s+dogfood$/m);
		assert.match(text, /^file\s+\/data\/sessions\/pi-id\.jsonl$/m);
		assert.match(text, /^messages\s+12$/m);
		assert.match(text, /^model\s+openai\/gpt-5$/m);
		assert.match(text, /^thinking\s+high$/m);
		assert.match(text, /^tokens\s+↑1200 ↓345 R6789 W12$/m);
		assert.match(text, /^cost\s+\$0\.0456$/m);
		assert.match(text, /^context\s+12\.3% of 100000$/m);
	});

	it("falls back to the status info and marks missing values", () => {
		const text = formatSession({ id: "pi-id", state: "idle", cwd: "/x", messageCount: 0 }, null);
		assert.match(text, /^model\s+—$/m);
		assert.match(text, /^thinking\s+—$/m);
		assert.match(text, /^tokens\s+—$/m);
		assert.match(text, /^cost\s+—$/m);
		assert.match(text, /^context\s+—$/m);
		assert.match(text, /^messages\s+0$/m);
		assert.match(text, /^logical\s+—$/m);
	});

	it("shows a token window when percent is unavailable", () => {
		const text = formatSession(info, {
			...footer,
			context: { percent: null, window: 200_000 },
		});
		assert.match(text, /^context\s+200000 tokens$/m);
	});
});

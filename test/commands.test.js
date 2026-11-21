import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BUILTIN_COMMANDS,
	COMMANDS,
	TUI_ONLY_COMMANDS,
	classifyInput,
	findCommand,
	isAllowed,
	resolvePolicy,
	visibleCommands,
} from "../src/client/commands.js";

describe("classifyInput", () => {
	it("treats blank input as empty", () => {
		assert.equal(classifyInput("").kind, "empty");
		assert.equal(classifyInput("   \n\t ").kind, "empty");
		assert.equal(classifyInput(undefined).kind, "empty");
	});

	it("keeps plain text as text, trimmed once", () => {
		const action = classifyInput("  hello there  ");
		assert.equal(action.kind, "text");
		assert.equal(action.text, "hello there");
		assert.equal(action.name, null);
	});

	it("classifies a bare slash as the menu, not a prompt", () => {
		assert.equal(classifyInput("/").kind, "menu");
		assert.equal(classifyInput("  /  ").kind, "menu");
	});

	it("parses slash names and arguments, keeping the verbatim text", () => {
		assert.deepEqual(
			{ kind: classifyInput("/compact").kind, name: classifyInput("/compact").name, args: classifyInput("/compact").args },
			{ kind: "builtin", name: "compact", args: "" },
		);
		const withArgs = classifyInput("/compact  keep the API notes  ");
		assert.equal(withArgs.kind, "builtin");
		assert.equal(withArgs.name, "compact");
		assert.equal(withArgs.args, "keep the API notes");
		assert.equal(withArgs.text, "/compact  keep the API notes");
	});

	it("knows the built-in catalog and the TUI-only catalog", () => {
		assert.equal(classifyInput("/model").kind, "builtin");
		assert.equal(classifyInput("/thinking high").kind, "builtin");
		assert.equal(classifyInput("/settings").kind, "tui");
		assert.equal(classifyInput("/login anthropic").kind, "tui");
		assert.equal(classifyInput("/tree").command?.ticket, "08-session-commands");
	});

	it("passes extension commands, skills, templates and unknown slashes through", () => {
		for (const line of ["/fit list", "/skill:review", "/a-template arg", "/Compact", "/thing"]) {
			const action = classifyInput(line);
			assert.equal(action.kind, "passthrough", line);
			assert.equal(action.text, line);
		}
		assert.equal(classifyInput("/fit list").name, "fit");
		assert.equal(classifyInput("/fit list").args, "list");
	});

	it("classifies ! and !! the way the TUI does", () => {
		assert.deepEqual(classifyInput("!ls"), {
			kind: "bash",
			text: "!ls",
			command: "ls",
			excludeFromContext: false,
			name: null,
			args: "ls",
		});
		const excluded = classifyInput("!!  ls -la  ");
		assert.equal(excluded.kind, "bash");
		assert.equal(excluded.command, "ls -la");
		assert.equal(excluded.excludeFromContext, true);
		// The bang check is on the trimmed line: leading spaces still mean bash.
		assert.equal(classifyInput("  !ls").kind, "bash");
		assert.equal(classifyInput("  !!ls").excludeFromContext, true);
	});

	it("keeps !/!! with no command as an empty bash action the caller ignores", () => {
		for (const line of ["!", "!!", "! ", "!!   "]) {
			const action = classifyInput(line);
			assert.equal(action.kind, "bash", line);
			assert.equal(action.command, "");
		}
	});
});

describe("catalog", () => {
	it("has one entry per command, with the 02 built-ins", () => {
		assert.deepEqual(
			BUILTIN_COMMANDS.map((command) => command.name),
			["compact", "name", "session", "copy", "model", "thinking", "new", "resume", "quit"],
		);
		assert.ok(TUI_ONLY_COMMANDS.length >= 10);
		assert.equal(COMMANDS.length, BUILTIN_COMMANDS.length + TUI_ONLY_COMMANDS.length);
		const names = COMMANDS.map((command) => command.name);
		assert.equal(new Set(names).size, names.length);
	});

	it("looks names up bare, with or without a leading slash", () => {
		assert.equal(findCommand("compact")?.source, "builtin");
		assert.equal(findCommand("/compact")?.source, "builtin");
		assert.equal(findCommand("fit"), undefined);
	});
});

describe("resolvePolicy", () => {
	it("is neutral with no layers", () => {
		assert.deepEqual(resolvePolicy(), { allow: [], deny: [], bash: true });
		assert.deepEqual(resolvePolicy([]), { allow: [], deny: [], bash: true });
	});

	it("unions deny and normalizes names", () => {
		const policy = resolvePolicy([{ deny: ["/compact", "fit"] }, { deny: ["fit", "tree"] }]);
		assert.deepEqual(policy.deny, ["compact", "fit", "tree"]);
	});

	it("intersects non-empty allow lists and treats empty as no restriction", () => {
		assert.deepEqual(resolvePolicy([{ allow: [] }, { allow: ["compact", "name"] }]).allow, ["compact", "name"]);
		assert.deepEqual(
			resolvePolicy([{ allow: ["compact", "name", "model"] }, { allow: ["name", "model"] }]).allow,
			["name", "model"],
		);
		assert.deepEqual(resolvePolicy([{ allow: ["compact"] }, { allow: [] }]).allow, ["compact"]);
		assert.deepEqual(resolvePolicy([{ allow: ["compact"] }, { allow: ["name"] }]).allow, []);
	});

	it("ANDs bash, so one false layer disables it", () => {
		assert.equal(resolvePolicy([{ bash: true }, { bash: false }]).bash, false);
		assert.equal(resolvePolicy([{ bash: true }, {}]).bash, true);
	});
});

describe("isAllowed", () => {
	const policy = { allow: ["compact", "fit"], deny: ["fit"], bash: true };

	it("lets deny win over allow", () => {
		assert.equal(isAllowed("fit", policy), false);
		assert.equal(isAllowed("/fit", policy), false);
		assert.equal(isAllowed("compact", policy), true);
	});

	it("restricts anything outside a non-empty allow list", () => {
		assert.equal(isAllowed("model", policy), false);
		assert.equal(isAllowed("model", { allow: [], deny: [], bash: true }), true);
		assert.equal(isAllowed("model", null), true);
	});
});

describe("visibleCommands", () => {
	it("drops denied commands but keeps the TUI-only ones for the menu", () => {
		const visible = visibleCommands({ allow: [], deny: ["settings", "compact"], bash: true });
		const names = visible.map((command) => command.name);
		assert.equal(names.includes("settings"), false);
		assert.equal(names.includes("compact"), false);
		assert.equal(names.includes("model"), true);
	});
});

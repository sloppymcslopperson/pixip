import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BUILTIN_COMMANDS,
	COMMANDS,
	TUI_ONLY_COMMANDS,
	classifyInput,
	commandQuery,
	filterCommands,
	findCommand,
	isAllowed,
	menuCatalog,
	menuInsertText,
	resolveModelArgument,
	resolvePolicy,
	resolveThinkingArgument,
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
			{
				kind: classifyInput("/compact").kind,
				name: classifyInput("/compact").name,
				args: classifyInput("/compact").args,
			},
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
		assert.equal(classifyInput("/tree").kind, "builtin");
		assert.equal(classifyInput("/fork abc123").kind, "builtin");
		assert.equal(classifyInput("/import /tmp/x.jsonl").kind, "builtin");
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
			[
				"compact",
				"name",
				"session",
				"copy",
				"model",
				"thinking",
				"new",
				"resume",
				"quit",
				"tree",
				"fork",
				"clone",
				"import",
				"export",
			],
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
		assert.deepEqual(resolvePolicy([{ allow: ["compact", "name", "model"] }, { allow: ["name", "model"] }]).allow, [
			"name",
			"model",
		]);
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

describe("commandQuery", () => {
	it("is the bare name while the composer line is in command position", () => {
		assert.equal(commandQuery("/"), "");
		assert.equal(commandQuery("/com"), "com");
		assert.equal(commandQuery("/Fit"), "Fit");
	});

	it("closes once there is whitespace or the line is not a command", () => {
		for (const line of ["", "hi", "hi /", " /compact", "/compact ", "/compact args", "/fit x"]) {
			assert.equal(commandQuery(line), null, JSON.stringify(line));
		}
	});
});

describe("menuCatalog", () => {
	it("adds live commands once and marks the static TUI-only ones", () => {
		const commands = menuCatalog(null, [
			{ name: "fit", description: "FIT board", source: "extension" },
			{ name: "fix-tests", description: "Fix tests", source: "prompt" },
			{ name: "/fit", description: "duplicate", source: "extension" },
			{ name: "", description: "empty", source: "skill" },
		]);
		const names = commands.map((command) => command.name);
		assert.equal(names.filter((name) => name === "fit").length, 1);
		assert.equal(commands.find((command) => command.name === "fit")?.summary, "FIT board");
		assert.equal(commands.find((command) => command.name === "fix-tests")?.source, "prompt");
		assert.equal(commands.find((command) => command.name === "settings")?.tuiOnly, true);
		assert.equal(commands.find((command) => command.name === "tree")?.tuiOnly, false);
		assert.equal(commands.find((command) => command.name === "compact")?.tuiOnly, false);
	});

	it("filters denied static and live commands", () => {
		const commands = menuCatalog({ allow: [], deny: ["settings", "fit"], bash: true }, [
			{ name: "fit", description: "FIT board", source: "extension" },
			{ name: "fix-tests", description: "Fix tests", source: "prompt" },
		]);
		const names = commands.map((command) => command.name);
		assert.equal(names.includes("settings"), false);
		assert.equal(names.includes("fit"), false);
		assert.equal(names.includes("fix-tests"), true);
	});
});

describe("filterCommands", () => {
	const commands = [
		{ name: "compact", summary: "compact the context" },
		{ name: "copy", summary: "copy the last assistant message" },
		{ name: "session", summary: "session id, file and usage" },
		{ name: "new", summary: "start a fresh session in this child" },
		{ name: "clone", summary: "duplicate the current branch" },
	];

	it("matches names case-insensitively", () => {
		assert.deepEqual(
			filterCommands(commands, "CO").map((command) => command.name),
			["compact", "copy"],
		);
	});

	it("puts name prefixes before other name matches, then description matches", () => {
		const ranked = [
			{ name: "resync", summary: "force a sync" },
			{ name: "sync", summary: "sync notes" },
			{ name: "copy", summary: "sync notes" },
		];
		assert.deepEqual(
			filterCommands(ranked, "sync").map((command) => command.name),
			["sync", "resync", "copy"],
		);
	});

	it("is alphabetical for an empty query and drops non-matches", () => {
		assert.deepEqual(
			filterCommands(commands, "").map((command) => command.name),
			["clone", "compact", "copy", "new", "session"],
		);
		assert.deepEqual(filterCommands(commands, "nothing"), []);
	});
});

describe("menuInsertText", () => {
	it("inserts the bare command and a space only when it takes arguments", () => {
		assert.equal(menuInsertText({ name: "compact", args: "[instructions]" }), "/compact ");
		assert.equal(menuInsertText({ name: "session", args: "" }), "/session");
		assert.equal(menuInsertText(null), "");
	});
});

describe("resolveModelArgument", () => {
	const models = [
		{ id: "fake-model", provider: "fake" },
		{ id: "fake-model", provider: "mirror" },
		{ id: "other-model", provider: "acme" },
		{ id: "deepseek-v4.1-flash", provider: "deepseek" },
	];

	it("prefers an exact provider/id", () => {
		assert.equal(resolveModelArgument(models, "deepseek/deepseek-v4.1-flash").model?.provider, "deepseek");
		assert.equal(resolveModelArgument(models, "ACME/OTHER-MODEL").model?.id, "other-model");
	});

	it("takes an exact id when it is unique", () => {
		assert.equal(resolveModelArgument(models, "other-model").model?.provider, "acme");
	});

	it("reports an ambiguous exact id with the matches", () => {
		const resolved = resolveModelArgument(models, "fake-model");
		assert.equal(resolved.model, undefined);
		assert.match(resolved.error, /ambiguous model/);
		assert.equal(resolved.matches.length, 2);
	});

	it("falls back to a unique suffix", () => {
		assert.equal(resolveModelArgument(models, "flash").model?.id, "deepseek-v4.1-flash");
		assert.match(resolveModelArgument(models, "model").error, /ambiguous model/);
	});

	it("reports an unknown model and the empty command", () => {
		assert.match(resolveModelArgument(models, "gpt").error, /unknown model/);
		assert.deepEqual(resolveModelArgument(models, "gpt").matches, []);
		assert.match(resolveModelArgument(models, "  ").error, /usage: \/model/);
	});
});

describe("resolveThinkingArgument", () => {
	const levels = ["off", "low", "medium", "high"];

	it("matches exactly, then by unique prefix", () => {
		assert.equal(resolveThinkingArgument(levels, "medium").level, "medium");
		assert.equal(resolveThinkingArgument(levels, "med").level, "medium");
		assert.equal(resolveThinkingArgument(levels, "H").level, "high");
	});

	it("reports ambiguous prefixes and unknown levels", () => {
		assert.match(resolveThinkingArgument(["high", "higher"], "h").error, /ambiguous/);
		const unknown = resolveThinkingArgument(levels, "turbo");
		assert.match(unknown.error, /unknown thinking level/);
		assert.match(unknown.error, /off, low, medium, high/);
		assert.match(resolveThinkingArgument(levels, "").error, /usage: \/thinking/);
	});
});

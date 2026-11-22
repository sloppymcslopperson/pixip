import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePrintArgs } from "../src/print.ts";

test("parsePrintArgs reads the prompt, model and CLI parity flags", () => {
	assert.deepEqual(parsePrintArgs(["--print", "hello", "world"]), { prompt: "hello world" });
	assert.deepEqual(
		parsePrintArgs([
			"--print",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--thinking",
			"off",
			"--model",
			"fake/fake-model",
			"label this",
		]),
		{ model: "fake/fake-model", prompt: "label this" },
	);
	assert.deepEqual(parsePrintArgs(["-p", "--model=fake/other", "x"]), {
		model: "fake/other",
		prompt: "x",
	});
	assert.throws(() => parsePrintArgs(["--print"]), /requires a prompt/);
	assert.throws(() => parsePrintArgs(["--print", "--model"]), /requires a value/);
	assert.throws(() => parsePrintArgs(["--print", "--wat", "x"]), /Unknown argument/);
});

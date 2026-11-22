import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { askWithDialogs, askWithPanel } from "../src/index.ts";
import { validateQuestions, type Question } from "../src/questions.ts";

function questions(...input: unknown[]): Question[] {
	const parsed = validateQuestions(input);
	assert.equal(parsed.ok, true);
	return parsed.ok ? parsed.questions : [];
}

function queueUi(selects: Array<string | undefined>, inputs: Array<string | undefined> = []) {
	const calls: Array<{ title: string; options: string[]; opts?: unknown }> = [];
	const typed: string[] = [];
	return {
		calls,
		typed,
		select: async (title: string, options: string[], opts?: unknown) => {
			calls.push({ title, options, opts });
			return selects.shift();
		},
		input: async (title: string) => {
			typed.push(title);
			return inputs.shift();
		},
	};
}

describe("askWithPanel", () => {
	const list = questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] });

	it("sends the surface with the 15 minute timeout and normalizes the action", async () => {
		let received: unknown;
		const result = await askWithPanel(
			{
				panel: async (payload: unknown, opts: unknown) => {
					received = opts;
					assert.equal((payload as { mode?: string }).mode, "a2ui");
					return JSON.stringify({
						name: "submit",
						context: { answers: { color: { selected: ["red"] } } },
					});
				},
			} as never,
			list,
			undefined,
		);
		assert.deepEqual(received, { timeout: 900_000 });
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") assert.equal(result.answers[0]?.selected[0], "red");
	});

	it("treats an explicit cancel action as a dismissal", async () => {
		const result = await askWithPanel({ panel: async () => ({ name: "cancel" }) } as never, list, undefined);
		assert.deepEqual(result, { kind: "cancelled", answers: [] });
	});

	it("reports a missing message, undefined result or thrown panel as an error", async () => {
		for (const panel of [
			async () => undefined,
			async () => {
				throw new Error("boom");
			},
		]) {
			const result = await askWithPanel({ panel } as never, list, undefined);
			assert.equal(result.kind, "lost");
		}
	});

	it("accepts a partial submit and leaves untouched questions unanswered", async () => {
		const list = questions(
			{ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] },
			{ id: "note", prompt: "Note", widget: "text" },
		);
		const result = await askWithPanel(
			{
				panel: async () =>
					JSON.stringify({
						name: "submit",
						context: { answers: { color: { selected: ["red"], custom: "" } } },
					}),
			} as never,
			list,
			undefined,
		);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") {
			assert.equal(result.answers.length, 1);
			assert.equal(result.answers[0]?.id, "color");
		}
	});

	it("reports a host without a panel as unavailable", async () => {
		const result = await askWithPanel({} as never, list, undefined);
		assert.equal(result.kind, "unavailable");
	});
});

describe("askWithDialogs", () => {
	it("asks a single choice through select", async () => {
		const ui = queueUi(["1. Red"]);
		const result = await askWithDialogs(
			ui,
			questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
			undefined,
		);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") assert.deepEqual(result.answers[0]?.selected, ["red"]);
	});

	it("toggles a multi-select and records Done", async () => {
		const ui = queueUi(["[ ] 1. S", "Done"]);
		const result = await askWithDialogs(
			ui,
			questions({
				id: "sizes",
				prompt: "Sizes",
				multiple: true,
				options: [
					{ value: "s", label: "S" },
					{ value: "m", label: "M" },
				],
			}),
			undefined,
		);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") assert.deepEqual(result.answers[0]?.selected, ["s"]);
	});

	it("records a custom-only single answer as wasCustom", async () => {
		const ui = queueUi(["Type your own answer"], ["teal"]);
		const result = await askWithDialogs(
			ui,
			questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
			undefined,
		);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") {
			assert.deepEqual(result.answers[0], { id: "color", selected: [], custom: "teal", wasCustom: true });
		}
	});

	it("asks a text widget through input", async () => {
		const ui = queueUi([], ["  hello  "]);
		const result = await askWithDialogs(ui, questions({ id: "note", prompt: "Note", widget: "text" }), undefined);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") assert.equal(result.answers[0]?.custom, "hello");
	});

	it("cancels when a dialog is dismissed", async () => {
		const ui = queueUi([undefined]);
		const result = await askWithDialogs(
			ui,
			questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
			undefined,
		);
		assert.equal(result.kind, "cancelled");
	});

	it("asks every question and reviews before submitting", async () => {
		const ui = queueUi(["1. Red", "Submit answers"], ["later"]);
		const result = await askWithDialogs(
			ui,
			questions(
				{ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] },
				{ id: "note", prompt: "Note", widget: "text" },
			),
			undefined,
		);
		assert.equal(result.kind, "answered");
		if (result.kind === "answered") {
			assert.equal(result.answers.length, 2);
			assert.equal(result.answers[1]?.custom, "later");
		}
		assert.match(ui.calls.at(-1)?.title ?? "", /Review/);
	});

	it("hands a typed-text question back to chat on ACP hosts", async () => {
		process.env.PIXIP_QUESTIONNAIRE_TYPED_TEXT = "0";
		try {
			const ui = queueUi(["Answer this in chat"]);
			const result = await askWithDialogs(
				ui,
				questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
				undefined,
			);
			assert.equal(result.kind, "deferred");
			if (result.kind === "deferred") assert.deepEqual(result.ids, ["color"]);
		} finally {
			delete process.env.PIXIP_QUESTIONNAIRE_TYPED_TEXT;
		}
	});

	it("hands an add-an-item request back to chat with the current selection", async () => {
		process.env.PIXIP_QUESTIONNAIRE_TYPED_TEXT = "0";
		try {
			const ui = queueUi(["[ ] 1. S", "Add an item in chat"]);
			const result = await askWithDialogs(
				ui,
				questions({
					id: "sizes",
					prompt: "Sizes",
					multiple: true,
					options: [
						{ value: "s", label: "S" },
						{ value: "m", label: "M" },
					],
				}),
				undefined,
			);
			assert.equal(result.kind, "deferred");
			if (result.kind === "deferred") {
				assert.deepEqual(result.adding, { id: "sizes", labels: ["S"] });
				assert.deepEqual(result.answers[0]?.selected, ["s"]);
			}
		} finally {
			delete process.env.PIXIP_QUESTIONNAIRE_TYPED_TEXT;
		}
	});

	it("reports a host without select as unavailable", async () => {
		const result = await askWithDialogs(
			{},
			questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
			undefined,
		);
		assert.equal(result.kind, "unavailable");
	});
});

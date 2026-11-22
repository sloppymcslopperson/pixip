import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePanelValue } from "../src/ask.ts";
import { answeredText, answerLine, normalizeAnswers, validateQuestions } from "../src/questions.ts";

function options(...values: string[]) {
	return values.map((value) => ({ value, label: value.toUpperCase() }));
}

describe("validateQuestions", () => {
	it("rejects an empty or missing question list", () => {
		assert.deepEqual(validateQuestions([]), { ok: false, error: "Error: provide at least one question." });
		assert.equal(validateQuestions(undefined).ok, false);
	});

	it("requires id and prompt and unique ids", () => {
		const missingId = validateQuestions([{ prompt: "Pick" }]);
		assert.equal(missingId.ok, false);
		const missingPrompt = validateQuestions([{ id: "a" }]);
		assert.equal(missingPrompt.ok, false);
		const duplicate = validateQuestions([
			{ id: "a", prompt: "Pick", options: options("x") },
			{ id: "a", prompt: "Pick again", options: options("y") },
		]);
		assert.equal(duplicate.ok, false);
		assert.match(duplicate.ok === false ? duplicate.error : "", /duplicate/i);
	});

	it("infers the deprecated legacy shape from options", () => {
		const choice = validateQuestions([{ id: "a", prompt: "Pick", options: options("x", "y") }]);
		assert.equal(choice.ok, true);
		if (choice.ok) {
			assert.equal(choice.questions[0]?.widget, "choice");
			assert.equal(choice.questions[0]?.legacy, true);
			assert.equal(choice.questions[0]?.label, "Q1");
		}
		const text = validateQuestions([{ id: "a", prompt: "Say", label: " Notes " }]);
		assert.equal(text.ok, true);
		if (text.ok) {
			assert.equal(text.questions[0]?.widget, "text");
			assert.equal(text.questions[0]?.label, "Notes");
			assert.equal(text.questions[0]?.legacy, true);
		}
	});

	it("rejects unknown widgets and ambiguous widget/options combinations", () => {
		const unknown = validateQuestions([{ id: "a", prompt: "Pick", widget: "slider" }]);
		assert.equal(unknown.ok, false);
		assert.match(unknown.ok === false ? unknown.error : "", /slider/);
		assert.match(unknown.ok === false ? unknown.error : "", /choice or text/);

		const textWithOptions = validateQuestions([{ id: "a", prompt: "Pick", widget: "text", options: options("x") }]);
		assert.equal(textWithOptions.ok, false);

		const choiceWithoutOptions = validateQuestions([{ id: "a", prompt: "Pick", widget: "choice" }]);
		assert.equal(choiceWithoutOptions.ok, false);

		const textMultiple = validateQuestions([{ id: "a", prompt: "Say", widget: "text", multiple: true }]);
		assert.equal(textMultiple.ok, false);
	});

	it("validates option values, labels and duplicates", () => {
		for (const broken of [
			[{ id: "a", prompt: "Pick", widget: "choice", options: [{ value: "", label: "x" }] }],
			[{ id: "a", prompt: "Pick", widget: "choice", options: [{ value: "x", label: "" }] }],
			[
				{
					id: "a",
					prompt: "Pick",
					widget: "choice",
					options: [
						{ value: "x", label: "X" },
						{ value: "x", label: "Again" },
					],
				},
			],
		]) {
			assert.equal(validateQuestions(broken).ok, false);
		}
	});

	it("keeps descriptions and the multiple flag on choice questions", () => {
		const parsed = validateQuestions([
			{
				id: "a",
				prompt: "Pick",
				widget: "choice",
				multiple: true,
				options: [{ value: "x", label: "X", description: "why" }],
			},
		]);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.questions[0]?.multiple, true);
			assert.equal(parsed.questions[0]?.options[0]?.description, "why");
		}
	});
});

describe("normalizeAnswers", () => {
	const questions = validateQuestions([
		{ id: "color", prompt: "Color", options: options("red", "blue") },
		{ id: "sizes", prompt: "Sizes", options: options("s", "m"), multiple: true },
		{ id: "note", prompt: "Note", widget: "text" },
	]);
	const parsed = questions.ok ? questions.questions : [];

	it("normalizes selected values, multiple values and custom text", () => {
		const answers = normalizeAnswers(parsed, {
			answers: {
				color: { selected: ["red"], custom: "" },
				sizes: { selected: ["s", "m"], custom: "" },
				note: { selected: [], custom: "  hello  " },
			},
		});
		assert.deepEqual(answers, [
			{ id: "color", selected: ["red"], custom: "", wasCustom: false },
			{ id: "sizes", selected: ["s", "m"], custom: "", wasCustom: false },
			{ id: "note", selected: [], custom: "hello", wasCustom: false },
		]);
	});

	it("marks a single-choice custom answer as wasCustom", () => {
		const answers = normalizeAnswers(parsed, { color: { selected: [], custom: "teal" } });
		assert.deepEqual(answers, [{ id: "color", selected: [], custom: "teal", wasCustom: true }]);
	});

	it("filters unknown values, deduplicates and omits unanswered questions", () => {
		const answers = normalizeAnswers(parsed, {
			color: { selected: ["red", "red", "green"], custom: "" },
			sizes: { selected: [], custom: "" },
		});
		assert.deepEqual(answers, [{ id: "color", selected: ["red"], custom: "", wasCustom: false }]);
	});

	it("accepts a single string selection from older surfaces", () => {
		const answers = normalizeAnswers(parsed, { color: { selected: "blue" } });
		assert.deepEqual(answers, [{ id: "color", selected: ["blue"], custom: "", wasCustom: false }]);
	});

	it("formats model-facing lines with labels and unanswered questions", () => {
		const answers = normalizeAnswers(parsed, { color: { selected: ["red"] }, note: { custom: "fine" } });
		assert.equal(answerLine(parsed[0]!, answers[0]), "Q1: user selected: 1. RED");
		assert.equal(answerLine(parsed[1]!, undefined), "Q2: Unanswered");
		assert.match(answeredText(parsed, answers), /Q1: user selected: 1\. RED/);
		assert.match(answeredText(parsed, answers), /Q2: Unanswered/);
		assert.match(answeredText(parsed, answers), /Q3: user wrote: fine/);
	});
});

describe("decodePanelValue", () => {
	const parsed = validateQuestions([{ id: "color", prompt: "Color", options: options("red", "blue") }]);
	const questions = parsed.ok ? parsed.questions : [];

	it("decodes a submit action from a JSON string", () => {
		const raw = JSON.stringify({
			name: "submit",
			surfaceId: "questionnaire",
			context: { answers: { color: { selected: ["red"], custom: "" } } },
		});
		assert.deepEqual(decodePanelValue(questions, raw), {
			kind: "answered",
			answers: [{ id: "color", selected: ["red"], custom: "", wasCustom: false }],
		});
	});

	it("treats the surface cancel action and cancelled:true as dismissals", () => {
		assert.deepEqual(decodePanelValue(questions, JSON.stringify({ name: "cancel" })), {
			kind: "cancelled",
			answers: [],
		});
		assert.deepEqual(decodePanelValue(questions, { cancelled: true }), { kind: "cancelled", answers: [] });
	});

	it("reports a closed or unreadable panel as lost, not cancelled", () => {
		for (const raw of [undefined, null, "", "{not json", { name: "something" }, 3]) {
			const result = decodePanelValue(questions, raw);
			assert.equal(result.kind, "lost");
		}
	});

	it("accepts a direct answers object", () => {
		const result = decodePanelValue(questions, { answers: { color: { selected: ["blue"] } } });
		assert.equal(result.kind, "answered");
	});
});

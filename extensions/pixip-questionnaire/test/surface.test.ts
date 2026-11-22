import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";

import { buildSurface, CATALOG_ID, DEFAULT_SURFACE_ID } from "../src/surface.ts";
import { validateQuestions } from "../src/questions.ts";

function questions(...input: Parameters<typeof validateQuestions>[0][]) {
	const parsed = validateQuestions(input);
	assert.equal(parsed.ok, true);
	return parsed.ok ? parsed.questions : [];
}

function surfaceOf(payload: ReturnType<typeof buildSurface>) {
	const create = (payload.messages[0] as { createSurface?: Record<string, unknown> })?.createSurface;
	assert.ok(create);
	return create;
}

describe("buildSurface", () => {
	it("builds one v1.0 createSurface with the Basic catalog and the answers model", () => {
		const payload = buildSurface(
			questions(
				{ id: "color", prompt: "Pick a color", label: "Color", options: [{ value: "red", label: "Red" }] },
				{ id: "notes", prompt: "Anything else?", widget: "text" },
			),
		);
		assert.equal(payload.mode, "a2ui");
		assert.equal(payload.surfaceId, DEFAULT_SURFACE_ID);
		assert.equal(payload.title, "Questionnaire");
		const create = surfaceOf(payload);
		assert.equal(create["catalogId"], CATALOG_ID);
		assert.equal(create["sendDataModel"], false);
		assert.deepEqual(create["dataModel"], {
			answers: {
				color: { selected: [], custom: "", moreInfo: false },
				notes: { selected: [], custom: "", moreInfo: false },
			},
		});
		const components = create["components"] as Array<Record<string, unknown>>;
		const tabs = components.find((component) => component["component"] === "Tabs");
		assert.deepEqual(tabs?.["tabs"], [
			{ title: "Color", child: "question_0" },
			{ title: "Q2", child: "question_1" },
		]);
		const picker = components.find((component) => component["component"] === "ChoicePicker");
		assert.equal(picker?.["variant"], "mutuallyExclusive");
		assert.deepEqual(picker?.["value"], { "@path": "/answers/color/selected" });
		const textFields = components.filter((component) => component["component"] === "TextField");
		assert.equal(textFields.length, 2);
		assert.deepEqual(textFields[1]?.["value"], { "@path": "/answers/notes/custom" });
		const buttons = components.filter((component) => component["component"] === "Button");
		// Only the footer actions; more information is a per-question checkbox.
		assert.equal(buttons.length, 2);
		const submit = buttons.find((component) => component["id"] === "submit_btn");
		assert.deepEqual(submit?.["action"], {
			event: { name: "submit", context: { answers: { "@path": "/answers" } } },
		});
		const moreInfo = components.filter((component) => component["component"] === "CheckBox");
		assert.equal(moreInfo.length, 2);
		assert.equal(moreInfo[0]?.["label"], "I need more information");
		assert.deepEqual(moreInfo[0]?.["value"], { "@path": "/answers/color/moreInfo" });
		const container = components.find((component) => component["id"] === "question_0");
		assert.deepEqual(container?.["children"], ["prompt_0", "choice_0", "text_0", "more_info_0"]);
	});

	it("uses multipleSelection for multi-select choice questions", () => {
		const payload = buildSurface(
			questions({
				id: "sizes",
				prompt: "Sizes",
				options: [
					{ value: "s", label: "Small" },
					{ value: "m", label: "Medium" },
				],
				multiple: true,
			}),
		);
		const components = surfaceOf(payload)["components"] as Array<Record<string, unknown>>;
		const picker = components.find((component) => component["component"] === "ChoicePicker");
		assert.equal(picker?.["variant"], "multipleSelection");
	});

	it("accepts explicit surface id and title", () => {
		const payload = buildSurface(questions({ id: "a", prompt: "A", widget: "text" }), {
			surfaceId: "custom",
			title: "Quick check",
		});
		assert.equal(payload.surfaceId, "custom");
		assert.equal(payload.title, "Quick check");
		assert.equal(surfaceOf(payload)["surfaceId"], "custom");
	});

	it("is valid against the official v1.0 processor and catalog", () => {
		const payload = buildSurface(
			questions(
				{ id: "color", prompt: "Pick a color", options: [{ value: "red", label: "Red" }] },
				{
					id: "sizes",
					prompt: "Pick sizes",
					options: [
						{ value: "s", label: "Small" },
						{ value: "m", label: "Medium" },
					],
					multiple: true,
				},
				{ id: "notes", prompt: "Notes", widget: "text" },
			),
		);
		const processor = new MessageProcessor([basicCatalog]);
		const errors = processor.processMessagesWithErrors(payload.messages);
		assert.deepEqual(errors, []);
		assert.ok(processor.getSurface(payload.surfaceId));
	});
});

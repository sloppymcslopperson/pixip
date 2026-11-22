import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { askWithTui } from "../src/tui.ts";
import { validateQuestions, type Question } from "../src/questions.ts";

function questions(...input: unknown[]): Question[] {
	const parsed = validateQuestions(input);
	assert.equal(parsed.ok, true);
	return parsed.ok ? parsed.questions : [];
}

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
};

const theme: ThemeLike = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

type Factory = (tui: TUI, theme: ThemeLike, keybindings: unknown, done: (result: unknown) => void) => Component;

describe("askWithTui", () => {
	it("records a single choice answer on Enter", async () => {
		let send: (data: string) => void = () => {};
		const custom = (async (factory: never) => {
			const tui = { requestRender: () => {} } as unknown as TUI;
			return await new Promise((resolve) => {
				const component = (factory as Factory)(tui, theme, {}, resolve);
				send = (data: string) => component.handleInput?.(data);
			});
		}) as never;
		const pending = askWithTui(
			{ custom },
			questions({ id: "color", prompt: "Color", options: [{ value: "red", label: "Red" }] }),
		);
		// The option cursor starts on the first choice.
		send("\r");
		const result = await pending;
		assert.equal(result.cancelled, false);
		assert.deepEqual(result.answers[0]?.selected, ["red"]);
	});

	it("toggles a multiple selection and Done advances to submit", async () => {
		let send: (data: string) => void = () => {};
		const custom = (async (factory: never) => {
			const tui = { requestRender: () => {} } as unknown as TUI;
			return await new Promise((resolve) => {
				const component = (factory as Factory)(tui, theme, {}, resolve);
				send = (data: string) => component.handleInput?.(data);
			});
		}) as never;
		const pending = askWithTui(
			{ custom },
			questions({
				id: "sizes",
				prompt: "Sizes",
				multiple: true,
				options: [
					{ value: "s", label: "S" },
					{ value: "m", label: "M" },
				],
			}),
		);
		send("\r"); // toggle S
		send("\x1b[B"); // M
		send("\x1b[B"); // custom
		send("\x1b[B"); // Done
		send("\r"); // single question submits
		const result = await pending;
		assert.deepEqual(result.answers[0]?.selected, ["s"]);
	});

	it("Escape cancels without an answer", async () => {
		let send: (data: string) => void = () => {};
		const custom = (async (factory: never) => {
			const tui = { requestRender: () => {} } as unknown as TUI;
			return await new Promise((resolve) => {
				const component = (factory as Factory)(tui, theme, {}, resolve);
				send = (data: string) => component.handleInput?.(data);
			});
		}) as never;
		const pending = askWithTui({ custom }, questions({ id: "note", prompt: "Note", widget: "text" }));
		send("\x1b");
		const result = await pending;
		assert.equal(result.cancelled, true);
		assert.deepEqual(result.answers, []);
	});
});

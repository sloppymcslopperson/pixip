/**
 * Questionnaire tool for Pi.
 *
 * Transport order:
 * 1. `ctx.ui.panel(payload, { timeout })` from `pixip-pi-host`: build an A2UI
 *    v1.0 surface for pixip's inline panel and wait for the action. The A2UI
 *    Cancel button is an explicit cancel; a panel that closes with no message is
 *    an error, not a dismissal.
 * 2. `ctx.ui.custom` on the TUI: an inline tabbed widget with the same answers.
 * 3. Sequential `select`/`input` dialogs (RPC/ACP), with the ACP "answer in
 *    chat" hand-off when the host cannot collect typed text.
 *
 * The tool is blocking in every path: no deferred results and no second
 * response channel.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { decodePanelValue, type AskResult } from "./ask.ts";
import {
	answeredText,
	answerLine,
	normalizeAnswers,
	type Question,
	type QuestionnaireDetails,
	validateQuestions,
} from "./questions.ts";
import { buildSurface, type PanelPayload } from "./surface.ts";
import { askWithTui } from "./tui.ts";

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned for this option" }),
	label: Type.String({ description: "Display text (1-5 words, concise)" }),
	description: Type.Optional(Type.String({ description: "Explanation of choice" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable unique identifier for this question" }),
	label: Type.Optional(
		Type.String({ description: "Short tab label, e.g. 'Scope' or 'Priority' (defaults to Q1, Q2, ...)" }),
	),
	prompt: Type.String({ description: "Complete question" }),
	widget: Type.Optional(
		Type.String({
			description:
				"Widget: 'choice' for options, 'text' for a free-form answer. Defaults to choice when options are present, text otherwise (deprecated).",
		}),
	),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Choices for a choice widget" })),
	multiple: Type.Optional(Type.Boolean({ description: "Allow selecting more than one choice" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask in this questionnaire" }),
});

const PANEL_TIMEOUT_MS = 15 * 60 * 1000;
const OTHER_CHOICE = "Type your own answer";
const CHAT_CHOICE = "Answer this in chat";
const ADD_CHOICE = "Add an item in chat";
const DONE_CHOICE = "Done";
const MORE_INFO_CHOICE = "More information";
const ANSWER_HERE_CHOICE = "Answer here";

type PanelFn = (payload: PanelPayload, opts?: { timeout?: number; signal?: AbortSignal }) => Promise<unknown>;
type PanelUi = ExtensionUIContext & { panel?: PanelFn };

interface DialogOptions {
	signal?: AbortSignal;
}

interface DialogUi {
	select?: (title: string, options: string[], opts?: DialogOptions) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string, opts?: DialogOptions) => Promise<string | undefined>;
}

function details(
	questions: Question[],
	answers: QuestionnaireDetails["answers"],
	cancelled: boolean,
	error?: string,
): QuestionnaireDetails {
	return error === undefined ? { questions, answers, cancelled } : { questions, answers, cancelled, error };
}

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details: details(questions, [], false, message),
	};
}

function textResult(text: string, value: QuestionnaireDetails) {
	return { content: [{ type: "text" as const, text }], details: value };
}

/**
 * True when the host can collect free-form text through `ui.input`.
 * pi-acp cancels input/editor requests, so offering a text prompt there ends in
 * a silent dismissal; the parent process command line is the local signal.
 */
function hostCollectsTypedText(): boolean {
	const forced = process.env.PIXIP_QUESTIONNAIRE_TYPED_TEXT ?? process.env.PI_QUESTIONNAIRE_TYPED_TEXT;
	if (forced === "0") return false;
	if (forced === "1") return true;

	let pid = process.pid;
	for (let depth = 0; depth < 3; depth += 1) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const ppid = Number.parseInt(fields[1] ?? "", 10);
			if (!Number.isFinite(ppid) || ppid <= 0) return true;
			if (/pi-acp/.test(readFileSync(`/proc/${ppid}/cmdline`, "utf8"))) return false;
			pid = ppid;
		} catch {
			return true;
		}
	}
	return true;
}

function dialogOptions(signal: AbortSignal | undefined): DialogOptions | undefined {
	return signal ? { signal } : undefined;
}

export async function askWithPanel(
	ui: PanelUi,
	questions: Question[],
	signal: AbortSignal | undefined,
): Promise<AskResult> {
	if (typeof ui.panel !== "function") {
		return { kind: "unavailable", error: "This host has no questionnaire panel." };
	}
	try {
		const raw = await ui.panel(buildSurface(questions), {
			timeout: PANEL_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		return decodePanelValue(questions, raw);
	} catch (error) {
		return {
			kind: "lost",
			error: `The questionnaire panel failed (${error instanceof Error ? error.message : String(error)}). Ask the question in plain text instead.`,
		};
	}
}

/** Sequential dialogs for hosts with select/input but no custom UI or panel. */
export async function askWithDialogs(
	ui: DialogUi,
	questions: Question[],
	signal: AbortSignal | undefined,
): Promise<AskResult> {
	if (typeof ui.select !== "function") {
		return { kind: "unavailable", error: "This host cannot show a questionnaire." };
	}
	const select = ui.select.bind(ui);
	const typing = hostCollectsTypedText();
	const input = typing && typeof ui.input === "function" ? ui.input.bind(ui) : undefined;
	const opts = dialogOptions(signal);
	const raw: Record<string, { selected: string[]; custom: string }> = {};
	const deferred: string[] = [];

	const moreInfo = (question: Question): AskResult => ({
		kind: "more_info",
		question,
		answers: normalizeAnswers(questions, raw).filter((answer) => answer.id !== question.id),
	});

	const entered = (id: string) => {
		const current = raw[id];
		if (!current) raw[id] = { selected: [], custom: "" };
		return raw[id] as { selected: string[]; custom: string };
	};

	for (const [index, question] of questions.entries()) {
		const title =
			questions.length > 1
				? `${question.label} (${index + 1}/${questions.length}): ${question.prompt}`
				: question.prompt;

		if (question.widget === "text") {
			if (input) {
				const mode = await select(title, [ANSWER_HERE_CHOICE, MORE_INFO_CHOICE], opts);
				if (mode === undefined) return { kind: "cancelled", answers: [] };
				if (mode === MORE_INFO_CHOICE) return moreInfo(question);
				const typed = await input(title, "type something...", opts);
				if (typed === undefined) return { kind: "cancelled", answers: [] };
				entered(question.id).custom = typed.trim();
			} else {
				const choice = await select(title, [CHAT_CHOICE, MORE_INFO_CHOICE], opts);
				if (choice === undefined) return { kind: "cancelled", answers: [] };
				if (choice === MORE_INFO_CHOICE) return moreInfo(question);
				deferred.push(question.id);
			}
			continue;
		}

		const lookup = new Map<string, string>();
		const optionLabels = question.options.map((option, optionIndex) => {
			const label = `${optionIndex + 1}. ${option.label}`;
			lookup.set(label, option.value);
			return label;
		});

		if (!question.multiple) {
			const options = [...optionLabels, typing ? OTHER_CHOICE : CHAT_CHOICE, MORE_INFO_CHOICE];
			let chosen: string | undefined;
			for (;;) {
				chosen = await select(title, options, opts);
				if (chosen === undefined) return { kind: "cancelled", answers: [] };
				if (chosen === MORE_INFO_CHOICE) return moreInfo(question);
				if (chosen === CHAT_CHOICE) {
					deferred.push(question.id);
					break;
				}
				if (chosen !== OTHER_CHOICE) break;
				const typed = await input?.("Type your own answer", "type something...", opts);
				if (typed === undefined) return { kind: "cancelled", answers: [] };
				entered(question.id).custom = typed.trim();
				chosen = undefined;
				break;
			}
			if (chosen !== undefined && chosen !== OTHER_CHOICE) {
				const value = lookup.get(chosen);
				if (value !== undefined) entered(question.id).selected = [value];
			}
			continue;
		}

		for (;;) {
			const selected = entered(question.id).selected;
			const marks = question.options.map((option, optionIndex) => {
				const label = `[${selected.includes(option.value) ? "x" : " "}] ${optionIndex + 1}. ${option.label}`;
				lookup.set(label, option.value);
				return label;
			});
			const options = [...marks, typing ? OTHER_CHOICE : CHAT_CHOICE, DONE_CHOICE, MORE_INFO_CHOICE];
			if (!typing) options.push(ADD_CHOICE);
			const chosen = await select(title, options, opts);
			if (chosen === undefined) return { kind: "cancelled", answers: [] };
			if (chosen === MORE_INFO_CHOICE) return moreInfo(question);
			if (chosen === CHAT_CHOICE) {
				deferred.push(question.id);
				break;
			}
			if (chosen === ADD_CHOICE) {
				const labels = question.options
					.filter((option) => selected.includes(option.value))
					.map((option) => option.label);
				return {
					kind: "deferred",
					answers: normalizeAnswers(questions, raw),
					ids: [],
					adding: { id: question.id, labels },
				};
			}
			if (chosen === DONE_CHOICE) break;
			if (chosen === OTHER_CHOICE) {
				const typed = await input?.("Type your own answer", "type something...", opts);
				if (typed === undefined) return { kind: "cancelled", answers: [] };
				const current = entered(question.id);
				current.custom = current.custom ? `${current.custom}; ${typed.trim()}` : typed.trim();
				continue;
			}
			const value = lookup.get(chosen);
			if (value === undefined) continue;
			const current = entered(question.id);
			current.selected = current.selected.includes(value)
				? current.selected.filter((item) => item !== value)
				: [...current.selected, value];
		}
	}

	if (deferred.length > 0) {
		return { kind: "deferred", answers: normalizeAnswers(questions, raw), ids: deferred };
	}

	if (questions.length > 1) {
		const summary = questions
			.map((question) =>
				answerLine(
					question,
					normalizeAnswers(questions, raw).find((a) => a.id === question.id),
				),
			)
			.join("\n");
		const review = await select(`Review\n${summary}`, ["Submit answers", "Cancel"], opts);
		if (review === undefined || review === "Cancel") return { kind: "cancelled", answers: [] };
	}

	return { kind: "answered", answers: normalizeAnswers(questions, raw) };
}

/** Model-facing instruction for a per-question "I need more information" press. */
export function moreInfoText(questions: Question[], result: Extract<AskResult, { kind: "more_info" }>): string {
	const question = result.question;
	const lines = [`The user asked for more information about ${question.label}: "${question.prompt}".`];
	if (question.widget === "choice" && question.options.length > 0) {
		const options = question.options.map((option, index) => `${index + 1}. ${option.label}`).join("; ");
		lines.push(`Its options are: ${options}.`);
	}
	lines.push(
		"Explain this question and its options in plain text in chat, then wait for the user's reply before deciding whether to ask it again. " +
			"This is not a dismissal and it is not an answer to this question; do not re-ask this questionnaire automatically in the same turn.",
	);
	const collected = questions
		.filter((candidate) => candidate.id !== question.id)
		.map((candidate) =>
			answerLine(
				candidate,
				result.answers.find((answer) => answer.id === candidate.id),
			),
		)
		.filter((line) => !line.endsWith(": Unanswered"));
	if (collected.length > 0) lines.push("", "Already answered:", ...collected);
	return lines.join("\n");
}

function deferredText(questions: Question[], result: Extract<AskResult, { kind: "deferred" }>): string {
	const labelOf = (id: string) => questions.find((question) => question.id === id)?.label ?? id;
	const collected = questions
		.map((question) =>
			answerLine(
				question,
				result.answers.find((answer) => answer.id === question.id),
			),
		)
		.filter((line) => !line.endsWith(": Unanswered"));
	const lines: string[] = [];
	if (result.adding) {
		const already = result.adding.labels.length > 0 ? result.adding.labels.join(", ") : "nothing yet";
		lines.push(
			`The user wants to add items to ${labelOf(result.adding.id)} that are not in the offered options. ` +
				`Already selected there: ${already}. Ask them in plain text which additional items they want, ` +
				"then continue with their reply. Do not treat this as a dismissal and do not re-ask it with this tool.",
		);
	} else {
		lines.push(
			`The user chose to answer ${result.ids.map(labelOf).join(", ")} in their own words in chat, so no answer was captured there. ` +
				"Ask that question in plain text in your next message and use their reply. Do not treat this as a dismissal and do not re-ask it with this tool.",
		);
	}
	if (collected.length > 0) lines.push("", "Already answered:", ...collected);
	return lines.join("\n");
}

function finish(questions: Question[], result: AskResult) {
	switch (result.kind) {
		case "answered":
			return textResult(answeredText(questions, result.answers), details(questions, result.answers, false));
		case "cancelled":
			return textResult(
				"The user dismissed this questionnaire without submitting it. Do not continue with the current task: this means the user wants to clarify or pivot. Stop and wait for the user's next message.",
				details(questions, result.answers, true),
			);
		case "more_info":
			return textResult(moreInfoText(questions, result), details(questions, result.answers, false));
		case "deferred":
			return textResult(deferredText(questions, result), details(questions, result.answers, false));
		case "unavailable":
		case "lost":
			return errorResult(result.error, questions);
	}
}

export default function pixipQuestionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Each question names a widget: 'choice' (with options) or 'text' (free-form). " +
			"Choice questions also always get a 'Type your own answer' field. Omit widget only for legacy calls: options mean choice, otherwise text.",
		parameters: QuestionnaireParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = validateQuestions(params.questions);
			if (!parsed.ok) return errorResult(parsed.error);
			const questions = parsed.questions;
			const ui = ctx.ui as PanelUi;

			let result: AskResult;
			if (typeof ui.panel === "function") {
				result = await askWithPanel(ui, questions, signal);
			} else if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
				const tui = await askWithTui(ctx.ui, questions);
				result = tui.moreInfo
					? {
							kind: "more_info",
							question: tui.moreInfo,
							answers: tui.answers.filter((answer) => answer.id !== tui.moreInfo?.id),
						}
					: tui.cancelled
						? { kind: "cancelled", answers: [] }
						: { kind: "answered", answers: tui.answers };
			} else {
				result = await askWithDialogs(ctx.ui, questions, signal);
			}
			return finish(questions, result);
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("questionnaire ")) + theme.fg("muted", `${count} question(s)`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const value = result.details as QuestionnaireDetails | undefined;
			if (!value) return new Text("", 0, 0);
			if (value.error) return new Text(theme.fg("warning", value.error), 0, 0);
			if (value.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const lines = value.questions.map((question) =>
				answerLine(
					question,
					value.answers.find((answer) => answer.id === question.id),
				),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

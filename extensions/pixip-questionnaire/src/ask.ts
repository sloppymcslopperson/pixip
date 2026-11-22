// Outcomes of one questionnaire attempt and the decoder for the A2UI panel
// response. The panel returns an action JSON string (or an object in tests);
// cancel is an A2UI action named "cancel", while a closed panel with no message
// is a failure, not a dismissal.
import { normalizeAnswers, type Answer, type Question } from "./questions.ts";

export type AskResult =
	| { kind: "answered"; answers: Answer[] }
	| { kind: "cancelled"; answers: Answer[] }
	| { kind: "deferred"; answers: Answer[]; ids: string[]; adding?: { id: string; labels: string[] } }
	| { kind: "unavailable"; error: string }
	| { kind: "lost"; error: string };

interface ActionLike {
	name?: unknown;
	cancelled?: unknown;
	context?: unknown;
	answers?: unknown;
}

export function decodePanelValue(questions: Question[], raw: unknown): AskResult {
	if (raw === undefined || raw === null || raw === "") {
		return {
			kind: "lost",
			error: "The questionnaire panel closed without an answer. Ask the question in plain text instead.",
		};
	}

	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return { kind: "lost", error: "The questionnaire panel sent an unreadable answer. Ask in plain text instead." };
		}
	}
	if (!value || typeof value !== "object") {
		return { kind: "lost", error: "The questionnaire panel sent an empty answer. Ask in plain text instead." };
	}

	const action = value as ActionLike;
	if (action.cancelled === true || action.name === "cancel") {
		return { kind: "cancelled", answers: [] };
	}
	if (action.name === "submit") {
		return { kind: "answered", answers: normalizeAnswers(questions, action.context) };
	}
	if (action.answers !== undefined) {
		return { kind: "answered", answers: normalizeAnswers(questions, action.answers) };
	}

	return { kind: "lost", error: "The questionnaire panel sent an unsupported action. Ask in plain text instead." };
}

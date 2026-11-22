// Pure questionnaire model: widget selection, validation, answer
// normalization and model-facing text. No Pi, DOM or A2UI imports, so the tests
// can drive every case directly.

export const WIDGETS = ["choice", "text"] as const;
export type Widget = (typeof WIDGETS)[number];

export interface RawOption {
	value?: unknown;
	label?: unknown;
	description?: unknown;
}

export interface RawQuestion {
	id?: unknown;
	label?: unknown;
	prompt?: unknown;
	widget?: unknown;
	options?: unknown;
	multiple?: unknown;
}

export interface Option {
	value: string;
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	/** Always present after validation: the supplied label or `Q1`, `Q2`, ... */
	label: string;
	prompt: string;
	widget: Widget;
	options: Option[];
	multiple: boolean;
	/** True when the caller omitted `widget` and it was inferred (deprecated). */
	legacy: boolean;
}

export interface Answer {
	id: string;
	/** Selected option values, filtered through the question's options. */
	selected: string[];
	/** The typed "type your own answer" text, trimmed; empty when unused. */
	custom: string;
	/** True when a single-select answer is only custom text. */
	wasCustom: boolean;
}

export interface QuestionnaireDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	/** Set only when the questionnaire could not complete. */
	error?: string;
}

export type ValidationResult = { ok: true; questions: Question[] } | { ok: false; error: string };

function hasOptions(raw: RawQuestion): boolean {
	return Array.isArray(raw.options) && raw.options.length > 0;
}

function validateOptions(
	questionId: string,
	raw: unknown,
): { ok: true; options: Option[] } | { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: `Error: choice question "${questionId}" needs a non-empty options array.` };
	}
	const options: Option[] = [];
	const values = new Set<string>();
	for (const entry of raw as RawOption[]) {
		const value = typeof entry?.value === "string" ? entry.value.trim() : "";
		const label = typeof entry?.label === "string" ? entry.label.trim() : "";
		if (!value) return { ok: false, error: `Error: question "${questionId}" has an option without a value.` };
		if (!label) return { ok: false, error: `Error: question "${questionId}" has an option without a label.` };
		if (values.has(value)) {
			return { ok: false, error: `Error: question "${questionId}" has duplicate option value "${value}".` };
		}
		values.add(value);
		const description = typeof entry.description === "string" ? entry.description.trim() : "";
		options.push(description ? { value, label, description } : { value, label });
	}
	return { ok: true, options };
}

/**
 * Validate the tool input and apply the documented defaults.
 *
 * A question without `widget` is the deprecated legacy shape: choice when it
 * carries options, text otherwise. Anything that would need a guess is an
 * error rather than a silent default.
 */
export function validateQuestions(raw: unknown): ValidationResult {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: "Error: provide at least one question." };
	}

	const questions: Question[] = [];
	const ids = new Set<string>();

	for (const [index, entry] of raw.entries()) {
		const source = (entry ?? {}) as RawQuestion;
		const id = typeof source.id === "string" ? source.id.trim() : "";
		const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
		if (!id) return { ok: false, error: "Error: a question is missing its id." };
		if (ids.has(id)) return { ok: false, error: `Error: duplicate question id "${id}".` };
		ids.add(id);
		if (!prompt) return { ok: false, error: `Error: question "${id}" is missing its prompt.` };

		const labelInput = typeof source.label === "string" ? source.label.trim() : "";
		const label = labelInput || `Q${index + 1}`;
		const legacy = source.widget === undefined;
		const inferred = hasOptions(source) ? "choice" : "text";
		const widgetInput = typeof source.widget === "string" ? source.widget.trim() : "";
		const widget = legacy ? inferred : (widgetInput as Widget);
		if (!WIDGETS.includes(widget)) {
			return {
				ok: false,
				error: `Error: question "${id}" has unknown widget "${widgetInput}". Use ${WIDGETS.join(" or ")}.`,
			};
		}

		const multiple = source.multiple === true;
		if (widget === "text") {
			if (hasOptions(source)) {
				return {
					ok: false,
					error: `Error: text question "${id}" must not have options; drop "options" or use widget "choice".`,
				};
			}
			if (multiple) {
				return { ok: false, error: `Error: text question "${id}" cannot be multiple; use widget "choice".` };
			}
			questions.push({ id, label, prompt, widget, options: [], multiple: false, legacy });
			continue;
		}

		const options = validateOptions(id, source.options);
		if (!options.ok) return options;
		questions.push({ id, label, prompt, widget, options: options.options, multiple, legacy });
	}

	return { ok: true, questions };
}

function answerMap(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object") return {};
	const container = raw as { answers?: unknown };
	if (container.answers && typeof container.answers === "object") return container.answers as Record<string, unknown>;
	return raw as Record<string, unknown>;
}

/** Turn the panel's action context into normalized answers, in question order. */
export function normalizeAnswers(questions: Question[], raw: unknown): Answer[] {
	const source = answerMap(raw);
	const answers: Answer[] = [];
	for (const question of questions) {
		const entry = source[question.id];
		if (!entry || typeof entry !== "object") continue;
		const value = entry as { selected?: unknown; custom?: unknown };
		const selectedRaw = Array.isArray(value.selected)
			? value.selected
			: typeof value.selected === "string"
				? [value.selected]
				: [];
		const allowed = new Set(question.options.map((option) => option.value));
		const selected = [...new Set(selectedRaw.filter((item): item is string => typeof item === "string"))].filter(
			(value) => allowed.has(value),
		);
		const custom = typeof value.custom === "string" ? value.custom.trim() : "";
		if (selected.length === 0 && !custom) continue;
		answers.push({
			id: question.id,
			selected,
			custom,
			wasCustom: question.widget === "choice" && !question.multiple && selected.length === 0 && custom.length > 0,
		});
	}
	return answers;
}

export function selectedLabels(question: Question, answer: Answer): string[] {
	return answer.selected.map((value) => {
		const index = question.options.findIndex((option) => option.value === value);
		return index >= 0 ? `${index + 1}. ${question.options[index]?.label ?? value}` : value;
	});
}

/** One model-facing line per question; unanswered questions are explicit. */
export function answerLine(question: Question, answer: Answer | undefined): string {
	if (!answer) return `${question.label}: Unanswered`;
	if (answer.wasCustom) return `${question.label}: user wrote: ${answer.custom}`;
	const parts: string[] = [];
	const picked = selectedLabels(question, answer);
	if (picked.length > 0) parts.push(`user selected: ${picked.join(", ")}`);
	if (answer.custom) parts.push(`user wrote: ${answer.custom}`);
	if (parts.length === 0) return `${question.label}: Unanswered`;
	return `${question.label}: ${parts.join("; ")}`;
}

export function answeredText(questions: Question[], answers: Answer[]): string {
	return questions
		.map((question) =>
			answerLine(
				question,
				answers.find((answer) => answer.id === question.id),
			),
		)
		.join("\n");
}

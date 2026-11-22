// TUI fallback: a compact questionnaire widget used when the host has no
// `panel` but does expose `ui.custom`. It is written for this package, not
// shared with pi_questionare: tabs per question, a Submit tab for multi-question
// questionnaires, multi-select toggles, and an always-available free-form row.
import {
	Editor,
	type Component,
	type EditorTheme,
	Key,
	matchesKey,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { normalizeAnswers, type Answer, type Question } from "./questions.ts";

export interface TuiResult {
	answers: Answer[];
	cancelled: boolean;
}

interface Draft {
	selected: Set<string>;
	custom: string;
}

type Row =
	{ kind: "option"; value: string; label: string; description?: string } | { kind: "custom" } | { kind: "done" };

const OTHER_LABEL = "Type your own answer";
const DONE_LABEL = "Done";

function rowsFor(question: Question): Row[] {
	const rows: Row[] = question.options.map((option) => ({
		kind: "option",
		value: option.value,
		label: option.label,
		description: option.description,
	}));
	rows.push({ kind: "custom" });
	if (question.multiple) rows.push({ kind: "done" });
	return rows;
}

function draftsToAnswers(questions: Question[], drafts: Map<string, Draft>): Answer[] {
	const raw: Record<string, unknown> = {};
	for (const question of questions) {
		const draft = drafts.get(question.id);
		if (!draft) continue;
		raw[question.id] = { selected: [...draft.selected], custom: draft.custom };
	}
	return normalizeAnswers(questions, raw);
}

/**
 * Ask through the TUI. Single-question questionnaires submit as soon as the
 * answer is chosen; multi-question ones end on an explicit Submit tab that
 * accepts partial answers. Escape cancels.
 */
export interface TuiTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

export interface CustomUi {
	custom<T>(
		factory: (tui: TUI, theme: TuiTheme, keybindings: unknown, done: (result: T) => void) => Component,
	): Promise<T | null | undefined>;
}

export async function askWithTui(ui: CustomUi, questions: Question[]): Promise<TuiResult> {
	if (typeof ui.custom !== "function") return { answers: [], cancelled: true };
	const result = await ui.custom<TuiResult | null>((tui, theme, _keybindings, done) => {
		const drafts = new Map<string, Draft>();
		const multi = questions.length > 1;
		const submitTab = questions.length;
		let tab = 0;
		let cursor = 0;
		let inputFor: string | null = null;
		let cached: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};
		const draftOf = (question: Question): Draft => {
			let draft = drafts.get(question.id);
			if (!draft) {
				draft = { selected: new Set(), custom: "" };
				drafts.set(question.id, draft);
			}
			return draft;
		};
		const submit = (cancelled: boolean) => done({ answers: draftsToAnswers(questions, drafts), cancelled });

		const advance = () => {
			if (!multi) {
				submit(false);
				return;
			}
			tab = tab < submitTab - 1 ? tab + 1 : submitTab;
			cursor = 0;
			refresh();
		};

		editor.onSubmit = (value: string) => {
			if (!inputFor) return;
			const question = questions.find((candidate) => candidate.id === inputFor);
			if (!question) return;
			const draft = draftOf(question);
			draft.custom = value.trim();
			inputFor = null;
			editor.setText("");
			if (question.widget === "text") advance();
			else if (!question.multiple) {
				draft.selected.clear();
				advance();
			} else refresh();
		};

		function handleInput(data: string): void {
			if (inputFor) {
				if (matchesKey(data, Key.escape)) {
					inputFor = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (multi) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					tab = (tab + 1) % (submitTab + 1);
					cursor = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					tab = (tab - 1 + submitTab + 1) % (submitTab + 1);
					cursor = 0;
					refresh();
					return;
				}
			}

			if (tab === submitTab) {
				if (matchesKey(data, Key.enter)) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			const question = questions[tab];
			if (!question) return;
			const rows = rowsFor(question);
			const draft = draftOf(question);

			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(rows.length - 1, cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				submit(true);
				return;
			}
			if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.space)) return;

			const row = rows[cursor];
			if (!row) return;
			if (row.kind === "custom") {
				inputFor = question.id;
				editor.setText(draft.custom);
				refresh();
				return;
			}
			if (row.kind === "done") {
				advance();
				return;
			}
			if (question.multiple) {
				if (draft.selected.has(row.value)) draft.selected.delete(row.value);
				else draft.selected.add(row.value);
				refresh();
				return;
			}
			draft.selected = new Set([row.value]);
			draft.custom = "";
			advance();
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];
			const add = (text: string) => lines.push(...wrapTextWithAnsi(text, renderWidth));
			const addWith = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					add(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const pad = " ".repeat(prefixWidth);
				wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : pad}${line}`));
			};

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			if (multi) {
				const tabs = ["← "];
				questions.forEach((question, index) => {
					const draft = drafts.get(question.id);
					const answered = Boolean(draft && (draft.selected.size > 0 || draft.custom));
					const label = ` ${answered ? "■" : "□"} ${question.label} `;
					tabs.push(index === tab ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg("muted", label));
					tabs.push(" ");
				});
				const submitLabel = " ✓ Submit ";
				tabs.push(
					tab === submitTab ? theme.bg("selectedBg", theme.fg("text", submitLabel)) : theme.fg("dim", submitLabel),
				);
				addWith(" ", tabs.join(""));
				lines.push("");
			}

			if (tab === submitTab) {
				addWith(" ", theme.fg("text", "Submit answers"));
				lines.push("");
				for (const question of questions) {
					const draft = drafts.get(question.id);
					const picked = question.options.filter((option) => draft?.selected.has(option.value));
					const parts: string[] = [];
					if (picked.length > 0) parts.push(picked.map((option) => option.label).join(", "));
					if (draft?.custom) parts.push(`wrote: ${draft.custom}`);
					const value = parts.length > 0 ? theme.fg("text", parts.join("; ")) : theme.fg("warning", "Unanswered");
					addWith(" ", `${theme.fg("muted", `${question.label}: `)}${value}`);
				}
				lines.push("");
				addWith(" ", theme.fg("dim", "Enter submits (partial answers allowed) • Esc cancels"));
			} else {
				const question = questions[tab];
				if (question) {
					const draft = draftOf(question);
					addWith(" ", theme.fg("text", question.prompt));
					lines.push("");
					if (inputFor === question.id) {
						for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
						lines.push("");
						addWith(" ", theme.fg("dim", "Enter saves • Esc returns"));
					} else {
						const rows = rowsFor(question);
						rows.forEach((row, index) => {
							const active = index === cursor;
							const prefix = active ? theme.fg("accent", "> ") : "  ";
							let label: string;
							if (row.kind === "option") {
								const mark = question.multiple ? (draft.selected.has(row.value) ? "[x] " : "[ ] ") : "";
								label = `${mark}${row.label}`;
							} else if (row.kind === "custom") {
								label = draft.custom ? `${OTHER_LABEL}: ${draft.custom}` : OTHER_LABEL;
							} else {
								label = DONE_LABEL;
							}
							addWith(prefix, theme.fg(active ? "accent" : "text", label));
							if (row.kind === "option" && row.description) {
								addWith("     ", theme.fg("muted", row.description));
							}
						});
						lines.push("");
						addWith(
							" ",
							theme.fg(
								"dim",
								question.multiple
									? "↑↓ select • Enter toggle • Tab next • Esc cancel"
									: "↑↓ select • Enter answer • Tab next • Esc cancel",
							),
						);
					}
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});

	if (!result) return { answers: [], cancelled: true };
	return result;
}

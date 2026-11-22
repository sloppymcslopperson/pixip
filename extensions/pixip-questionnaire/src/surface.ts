// Build the A2UI v1.0 surface for a questionnaire. Messages are plain JSON so
// the extension ships with no A2UI runtime dependency; tests validate the shape
// against @a2ui/web_core (a devDependency).
import type { Question } from "./questions.ts";

/** v1.0 Basic catalog id, fixed: pixip renders only this catalog. */
export const CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
export const DEFAULT_SURFACE_ID = "questionnaire";
export const DEFAULT_TITLE = "Questionnaire";

export interface PanelPayload {
	title: string;
	mode: "a2ui";
	surfaceId: string;
	messages: unknown[];
}

export interface SurfaceOptions {
	surfaceId?: string;
	title?: string;
}

function text(id: string, content: string): unknown {
	return { id, component: "Text", text: content };
}

function button(id: string, labelId: string, label: string, variant: string, action: unknown): unknown[] {
	return [text(labelId, label), { id, component: "Button", child: labelId, variant, action }];
}

/** Action context for a per-question explanation request (legacy panels). */

/**
 * One createSurface message: title, one tab per question, and a footer with
 * Cancel and Submit. Choice questions bind both a ChoicePicker and a free-form
 * TextField; text questions bind only the TextField.
 */
export function buildSurface(questions: Question[], options: SurfaceOptions = {}): PanelPayload {
	const surfaceId = options.surfaceId ?? DEFAULT_SURFACE_ID;
	const title = options.title ?? DEFAULT_TITLE;
	const dataModel: Record<string, unknown> = { answers: {} };
	const answers = dataModel["answers"] as Record<string, unknown>;

	const components: unknown[] = [
		{
			id: "root",
			component: "Column",
			children: ["title", "tabs", "footer"],
		},
		{ id: "title", component: "Text", variant: "body", text: title },
	];

	const tabs: Array<{ title: string; child: string }> = [];

	questions.forEach((question, index) => {
		const containerId = `question_${index}`;
		const promptId = `prompt_${index}`;
		const moreInfoId = `more_info_${index}`;
		const children = [promptId];
		answers[question.id] = { selected: [], custom: "", moreInfo: false };

		if (question.widget === "choice") {
			children.push(`choice_${index}`);
			components.push({
				id: `choice_${index}`,
				component: "ChoicePicker",
				label: "Choose",
				variant: question.multiple ? "multipleSelection" : "mutuallyExclusive",
				options: question.options.map((option) => ({ value: option.value, label: option.label })),
				value: { "@path": `/answers/${question.id}/selected` },
			});
		}

		children.push(`text_${index}`, moreInfoId);
		components.push(
			{ id: containerId, component: "Column", children },
			text(promptId, question.prompt),
			{
				id: `text_${index}`,
				component: "TextField",
				label: "Type your own answer",
				placeholder: "type something...",
				value: { "@path": `/answers/${question.id}/custom` },
			},
			{
				id: moreInfoId,
				component: "CheckBox",
				label: "I need more information",
				value: { "@path": `/answers/${question.id}/moreInfo` },
			},
		);
		tabs.push({ title: question.label, child: containerId });
	});

	components.push({ id: "tabs", component: "Tabs", tabs });

	components.push(
		{ id: "footer", component: "Row", children: ["cancel_btn", "submit_btn"] },
		...button("cancel_btn", "cancel_label", "Cancel", "borderless", {
			event: { name: "cancel" },
		}),
		...button("submit_btn", "submit_label", "Submit", "primary", {
			event: { name: "submit", context: { answers: { "@path": "/answers" } } },
		}),
	);

	return {
		title,
		mode: "a2ui",
		surfaceId,
		messages: [
			{
				version: "1.0",
				createSurface: {
					surfaceId,
					catalogId: CATALOG_ID,
					sendDataModel: false,
					dataModel,
					components,
				},
			},
		],
	};
}

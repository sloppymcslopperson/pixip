/**
 * Session label helpers. Automatic labels are 3-5 words, sentence case and
 * short enough for the dashboard row; the same normalization guards a model
 * reply and the local fallback.
 */

export const TITLE_MAX_WORDS = 5;
export const TITLE_MAX_CHARS = 40;
const TITLE_PROMPT_CHARS = 4000;

/** Strip markdown-ish noise and turn the first useful line into a short label. */
export function normalizeTitle(raw: string): string {
	const line = String(raw ?? "")
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return "";
	let text = line
		.replace(/^(?:title|label|session)\s*[:-]\s*/i, "")
		.replace(/^[\s"'`*_#>-]+/, "")
		.replace(/[\s"'`*_#.!?,;:]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	const words = text.split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS);
	text = words.join(" ");
	if (text.length > TITLE_MAX_CHARS) {
		const clipped: string[] = [];
		for (const word of words) {
			const next = [...clipped, word].join(" ");
			if (next.length > TITLE_MAX_CHARS) break;
			clipped.push(word);
		}
		text = clipped.join(" ") || words[0]?.slice(0, TITLE_MAX_CHARS) || "";
	}
	return sentenceCase(text);
}

/** True when a first prompt is a slash command rather than plain text. */
export function isSlashPrompt(text: string): boolean {
	return /^\s*\//.test(String(text ?? ""));
}

/**
 * Text of a Pi message. `content` is a string or an array of text/image parts;
 * only text parts reach the title call. A slash command's expanded user message
 * is the same text the model sees, which is what the label should describe.
 */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const { type, text } = part as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string" && text.trim()) parts.push(text);
	}
	return parts.join("\n");
}

/**
 * Never let a missing/failed model leave the session unnamed. A FIT or
 * slash-command prompt often has boilerplate before the task, so prefer an
 * explicit `title:` field when one is present.
 */
export function fallbackTitle(prompt: string): string {
	const text = String(prompt ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^[/!]+/, " ");
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const titled = lines.find(
		(line) => /^title\s*:/i.test(line) && !/^\(empty\)$/i.test(line.replace(/^title\s*:/i, "").trim()),
	);
	if (titled) return normalizeTitle(titled.replace(/^title\s*:/i, ""));
	return normalizeTitle(lines.filter((line) => !/^title\s*:/i.test(line)).join("\n"));
}

/** The one-shot prompt sent to the title model. Keep the user text bounded. */
export function titlePrompt(prompt: string): string {
	return [
		"Write a descriptive session label for the task in this first user prompt.",
		"The prompt may be a slash-command template with process boilerplate: board paths, review or commit steps, tool names, and instructions about where to work or what to do afterward. Ignore those process instructions and label the actual task the user cares about. Ticket ids and revisions are useful context; keep them only when they help identify the task.",
		"Reach for the substance: if the prompt has a `title:` field, a `### Goal`, a summary, or a sentence that says what should change, use that subject. Name the concrete feature, bug, file, or decision and the action on it.",
		"Do not answer with a generic label such as 'Work on ticket', 'Fix issue', 'Update code', 'Implement changes', or 'Session title' when a specific detail is available.",
		`Reply with only 3 to ${TITLE_MAX_WORDS} words in sentence case, no quotes, no punctuation, at most ${TITLE_MAX_CHARS} characters.`,
		"Do not use tools.",
		"",
		String(prompt ?? "").slice(0, TITLE_PROMPT_CHARS),
	].join("\n");
}

function sentenceCase(text: string): string {
	const lower = text.toLocaleLowerCase();
	return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

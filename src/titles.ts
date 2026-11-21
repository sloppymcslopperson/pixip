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
		.replace(/^(?:title|label|session)\s*[:\-]\s*/i, "")
		.replace(/^[\s"'`*_#>\-]+/, "")
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

/** Never let a missing/failed model leave the session unnamed. */
export function fallbackTitle(prompt: string): string {
	const text = String(prompt ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^[/!]+/, " ");
	return normalizeTitle(text);
}

/** The one-shot prompt sent to the title model. Keep the user text bounded. */
export function titlePrompt(prompt: string): string {
	return [
		"Summarize this first user prompt as a session label.",
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

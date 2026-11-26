// Pure display helpers for composer reftag chips. No DOM and no imports, so
// node --test can cover them beside the grammar; the resolver owns state.
export const HISTORY_WORDS = 8;
export const INBOX_SUBJECT_CHARS = 60;

const PURPOSE_LABELS = {
	"attention-needed": "attention needed",
	deliverable: "deliverable",
	"extra-info": "extra info",
	"no-rush": "no rush",
};

export function purposeLabel(purpose) {
	return PURPOSE_LABELS[purpose] ?? String(purpose ?? "");
}

/** The first `count` words of `text`, with an ellipsis when text remains. */
export function firstWords(text, count = HISTORY_WORDS) {
	const words = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
	if (words.length <= count) return words.join(" ");
	return `${words.slice(0, count).join(" ")}…`;
}

/** Collapse whitespace and cap at `max` characters. */
export function clipText(text, max) {
	const collapsed = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Remove the first exact occurrence of `tag`; nothing else in the text changes. */
export function removeRefTag(text, tag) {
	if (typeof text !== "string" || typeof tag !== "string" || !tag) return text;
	const at = text.indexOf(tag);
	if (at < 0) return text;
	return text.slice(0, at) + text.slice(at + tag.length);
}

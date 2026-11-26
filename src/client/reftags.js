// The one reftag grammar. Plain JS because the browser serves this tree as-is;
// `src/reftags.ts` is a typed re-export for the hub, CLI and tests. Keep the
// regex here and nowhere else: a copied grammar is how two places drift.
//
// A tag is `[pixip-ref=history/<logicalSessionId>/<entryId>]`, the live variant
// `[pixip-ref=history/<logicalSessionId>/msg:<role>:<timestamp>]`, or
// `[pixip-ref=inbox/<inboxMessageId>]`. Brackets are required. Anything that
// does not match byte-for-byte stays literal prose.

const ID_SOURCE = "[A-Za-z0-9._-]+";
const ROLE_SOURCE = "[a-z][a-z0-9]*";
const STAMP_SOURCE = "\\d+";

/** Single source of truth for the tag shape (also used by docs tests). */
export const REF_TAG_SOURCE = `\\[pixip-ref=(?:history\\/(${ID_SOURCE})\\/(?:msg:(${ROLE_SOURCE}):(${STAMP_SOURCE})|(${ID_SOURCE}))|inbox\\/(${ID_SOURCE}))\\]`;

const ID = new RegExp(`^${ID_SOURCE}$`);
const ROLE = new RegExp(`^${ROLE_SOURCE}$`);
const STAMP = new RegExp(`^${STAMP_SOURCE}$`);
const SCAN = new RegExp(REF_TAG_SOURCE, "g");
const EXACT = new RegExp(`^${REF_TAG_SOURCE}$`);

function isId(value) {
	return typeof value === "string" && ID.test(value);
}

function stampText(value) {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	if (typeof value === "string" && STAMP.test(value)) return value;
	return null;
}

function refFromMatch(match) {
	if (match[5]) return { kind: "inbox", id: match[5] };
	if (match[2])
		return {
			kind: "history",
			session: match[1],
			message: { role: match[2], timestamp: Number(match[3]) },
		};
	return { kind: "history", session: match[1], entry: match[4] };
}

/**
 * Structured ref -> tag. Total: an unknown kind, missing session or a character
 * outside the strict classes returns `null`, so callers fall back to text.
 *
 * @param {{kind?: string, session?: string, entry?: string, message?: {role?: string, timestamp?: number|string}, id?: string}|null|undefined} ref
 * @returns {string|null}
 */
export function formatRefTag(ref) {
	if (!ref || typeof ref !== "object") return null;
	if (ref.kind === "inbox") {
		if (!isId(ref.id)) return null;
		return `[pixip-ref=inbox/${ref.id}]`;
	}
	if (ref.kind !== "history" || !isId(ref.session)) return null;
	if (isId(ref.entry)) return `[pixip-ref=history/${ref.session}/${ref.entry}]`;
	const message = ref.message;
	if (!message || typeof message !== "object") return null;
	if (typeof message.role !== "string" || !ROLE.test(message.role)) return null;
	const stamp = stampText(message.timestamp);
	if (stamp === null) return null;
	return `[pixip-ref=history/${ref.session}/msg:${message.role}:${stamp}]`;
}

/**
 * One tag -> structured ref. Surrounding whitespace is ignored; anything that is
 * not exactly one tag returns `null` and never throws.
 *
 * @param {unknown} text
 * @returns {{kind: string, session?: string, entry?: string, message?: {role: string, timestamp: number}, id?: string}|null}
 */
export function parseRefTag(text) {
	if (typeof text !== "string") return null;
	const match = EXACT.exec(text.trim());
	return match ? refFromMatch(match) : null;
}

/**
 * Every tag in `text`, in order, with offsets into the original string.
 * Non-matches (including a malformed `[pixip-ref=…]`) are skipped, never thrown.
 *
 * @param {unknown} text
 * @returns {{ref: object, tag: string, start: number, end: number}[]}
 */
export function scanRefTags(text) {
	if (typeof text !== "string") return [];
	const found = [];
	SCAN.lastIndex = 0;
	let match = SCAN.exec(text);
	while (match) {
		found.push({ ref: refFromMatch(match), tag: match[0], start: match.index, end: match.index + match[0].length });
		match = SCAN.exec(text);
	}
	return found;
}

/**
 * The live coverage key for a message or an entry, matching `coverageKey()` /
 * `coverageKeys()` in `src/jsonl.ts` for user and assistant messages.
 *
 * @param {{message?: {role?: unknown, timestamp?: unknown}, role?: unknown, timestamp?: unknown}|null|undefined} entryOrMessage
 * @returns {string|null}
 */
export function messageKey(entryOrMessage) {
	const message = entryOrMessage?.message ?? entryOrMessage;
	const role = message?.role;
	const stamp = message?.timestamp;
	if (typeof role !== "string" || !ROLE.test(role)) return null;
	if (typeof stamp !== "number" || !Number.isSafeInteger(stamp) || stamp < 0) return null;
	return `msg:${role}:${stamp}`;
}

/**
 * A history ref for a loaded entry: the Pi entry id when it has one, otherwise
 * the derived live message key. Returns `null` when neither is available.
 *
 * @param {unknown} sessionId logical session id
 * @param {{id?: unknown, message?: {role?: unknown, timestamp?: unknown}}|null|undefined} entry
 */
export function refForEntry(sessionId, entry) {
	if (!isId(sessionId) || !entry || typeof entry !== "object") return null;
	if (isId(entry.id)) return { kind: "history", session: sessionId, entry: entry.id };
	const key = messageKey(entry);
	if (!key) return null;
	const [, role, stamp] = key.split(":");
	return { kind: "history", session: sessionId, message: { role, timestamp: Number(stamp) } };
}

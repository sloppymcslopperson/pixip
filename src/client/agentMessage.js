// The one inter-agent marker grammar. `agent_send` prefixes a normal prompt
// with `[pixip-agent=<senderId>]` on its own first line; the transcript hides
// that line and paints the message as an agent bubble instead.
//
// The id charset is deliberately the same as reftags: ids are session ids, and
// a marker that does not match byte-for-byte stays ordinary user prose.

const ID_SOURCE = "[A-Za-z0-9._-]+";
const MARKER = new RegExp(`^\\[pixip-agent=(${ID_SOURCE})\\](?:\\r?\\n|$)`);

/**
 * Parse the marker at the start of a user message. The first line must be the
 * marker and nothing else; a missing marker, leading whitespace, a later line or
 * an invalid id all return `null`. A marker with no newline is a valid empty
 * message. Remaining CRLF is normalized to LF after the marker is removed.
 *
 * @param {unknown} text
 * @returns {{senderId: string, body: string}|null}
 */
export function parseAgentMessage(text) {
	if (typeof text !== "string") return null;
	const match = MARKER.exec(text);
	if (!match) return null;
	return {
		senderId: match[1],
		body: text.slice(match[0].length).replaceAll("\r\n", "\n"),
	};
}

function text(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Find the sender row in the dashboard list. The marker normally carries the
 * stable logical id, but explicit senders may be a current Pi id, so both are
 * accepted. The route prefers logicalId, then the current Pi id; missing rows
 * stay unlinked and fall back to the marker id as the display name.
 *
 * @param {string} senderId
 * @param {unknown} sessions
 * @returns {{senderId: string, name: string, routeId: string|null}}
 */
export function resolveAgentSender(senderId, sessions) {
	const rows = Array.isArray(sessions) ? sessions : [];
	const row =
		rows.find((session) => session && session.logicalId === senderId) ??
		rows.find((session) => session && session.id === senderId) ??
		null;
	const name = typeof row?.name === "string" && row.name.trim() ? row.name.trim() : senderId;
	const routeId = text(row?.logicalId) ?? text(row?.id);
	return { senderId, name, routeId };
}

// Pure inbox model: the sheet's filters, badge count and cap thresholds.
// The DOM lives in inbox.js; keeping these functions pure lets Node tests cover
// them without a browser.

export const PURPOSE_LABELS = {
	"attention-needed": "attention",
	deliverable: "deliverable",
	"extra-info": "extra info",
	"no-rush": "no rush",
};

export const INBOX_PURPOSES = ["attention-needed", "deliverable", "extra-info", "no-rush"];

export function shortId(id) {
	return typeof id === "string" ? id.slice(0, 8) : "";
}

export function purposeLabel(purpose) {
	return PURPOSE_LABELS[purpose] ?? String(purpose ?? "");
}

export function emptyInbox() {
	return { unread: 0, total: 0, limit: 200, newest: null, extension: false };
}

/**
 * Dashboard bar visibility. An empty inbox is dead chrome unless the optional
 * `pixip-inbox` extension announced itself, in which case the bar is the only
 * sign that agents can leave messages. Any non-archived message shows it too.
 */
export function inboxVisible(inbox) {
	const summary = inbox && typeof inbox === "object" ? inbox : {};
	return Boolean(summary.newest) || summary.extension === true;
}

/** Defensive normalization for a frame or an HTTP response. */
export function normalizeInbox(value) {
	const raw = value && typeof value === "object" ? value : {};
	const limit = Number.isFinite(raw.limit) && raw.limit > 0 ? raw.limit : emptyInbox().limit;
	return {
		unread: Number.isFinite(raw.unread) ? Math.max(0, raw.unread) : 0,
		total: Number.isFinite(raw.total) ? Math.max(0, raw.total) : 0,
		limit,
		newest: raw.newest && typeof raw.newest === "object" ? raw.newest : null,
		extension: raw.extension === true,
	};
}

/** Badge copy: no number at zero, and a cap so the header never grows. */
/** One-line bar copy: newest subject plus a flattened body preview. */
export function newestPreview(newest) {
	if (!newest || typeof newest !== "object") {
		return { subject: "inbox", preview: "no messages yet" };
	}
	const subject =
		typeof newest.subject === "string" && newest.subject.trim() ? newest.subject.trim() : "untitled message";
	const body = typeof newest.body === "string" ? newest.body.replace(/\s+/g, " ").trim() : "";
	const sender = newest.sender && typeof newest.sender.name === "string" ? newest.sender.name : "";
	return {
		subject,
		preview: body || (sender ? `from ${sender}` : "no preview"),
	};
}

export function badgeLabel(unread) {
	const count = Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;
	if (count === 0) return "";
	return count > 99 ? "99+" : String(count);
}

/** `full` at 99 %, `warn` at 50 %, otherwise `ok`. */
export function capLevel(total, limit) {
	if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return "ok";
	const ratio = total / limit;
	if (ratio >= 0.99) return "full";
	if (ratio >= 0.5) return "warn";
	return "ok";
}

export function capThresholds(level) {
	if (level === "full") return ["half", "full"];
	if (level === "warn") return ["half"];
	return [];
}

/** Thresholds that have not been toasted in this browser yet. */
export function newCapWarnings(level, warned = []) {
	const seen = new Set(Array.isArray(warned) ? warned : []);
	return capThresholds(level).filter((threshold) => !seen.has(threshold));
}

export function mergeWarnings(warned, next) {
	return [...new Set([...(Array.isArray(warned) ? warned : []), ...next])];
}

/**
 * Filter and sort the sheet rows. The API sends newest first already, but the
 * sort keeps optimistic updates stable.
 */
export function filterMessages(messages, options = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const filter = options.filter === "unread" ? "unread" : "all";
	const purpose = typeof options.purpose === "string" ? options.purpose : null;
	const archived = options.archived === true;
	return list
		.filter((message) => (archived ? Boolean(message.archivedAt) : !message.archivedAt))
		.filter((message) => (filter === "unread" ? !message.readAt : true))
		.filter((message) => (purpose ? message.purpose === purpose : true))
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function archivedCount(messages) {
	return (Array.isArray(messages) ? messages : []).filter((message) => Boolean(message.archivedAt)).length;
}

/** Resolve a sender against the dashboard's current session list. */
export function senderStatusFor(sender, sessions) {
	const logicalId = sender?.logicalId;
	const list = Array.isArray(sessions) ? sessions : [];
	const match = list.find((session) => session.logicalId === logicalId || session.id === logicalId);
	if (!match) return "deleted";
	if (match.state === "idle") return "idle";
	if (match.state === "busy" || match.state === "starting") return "running";
	return "stopped";
}

/** Reply opens only a session the dashboard can still address. */
export function replySession(sender, sessions) {
	const logicalId = sender?.logicalId;
	const list = Array.isArray(sessions) ? sessions : [];
	return list.find((session) => session.logicalId === logicalId || session.id === logicalId) ?? null;
}

/** The composer prefix that points the agent back at this message. */
export function replyPrefix(id) {
	return `[inbox ${shortId(id)}] `;
}

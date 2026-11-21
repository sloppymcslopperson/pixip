/**
 * Dashboard session grouping. Pure so the collapse/pinning rules are testable
 * without a DOM; `app.js` owns the localStorage plumbing and the elements.
 */

import { formatCwd } from "./footer.js";

export const COLLAPSED_STORAGE_KEY = "pixip.sessionGroups.collapsed";
export const KEEP_ACTIVE_STORAGE_KEY = "pixip.sessionGroups.keepActive";

const HOT = new Set(["busy", "starting"]);
const WARM = new Set(["idle"]);

/** Hot = actively booting/running; warm = an attached child that is idle. */
export function isHot(session) {
	return HOT.has(session?.state);
}

export function isWarm(session) {
	return WARM.has(session?.state);
}

export function isActiveSession(session) {
	return isHot(session) || isWarm(session);
}

/** Bucket key: exact cwd with trailing slashes trimmed; blank is one fallback. */
export function normalizeCwd(cwd) {
	const text = typeof cwd === "string" ? cwd.trim() : "";
	if (!text) return "";
	const trimmed = text.replace(/\/+$/, "");
	return trimmed || "/";
}

function activity(session) {
	const value = Number(session?.lastActivity);
	return Number.isFinite(value) ? value : 0;
}

function byActivity(a, b) {
	return activity(b) - activity(a) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * Group sessions by cwd. Groups are ordered by their newest activity, rows are
 * newest first; a tie breaks on id (rows) or the cwd key (groups) so a refresh
 * never reshuffles equal timestamps.
 */
export function groupSessions(sessions) {
	const groups = new Map();
	for (const session of Array.isArray(sessions) ? sessions : []) {
		if (!session || typeof session !== "object") continue;
		const key = normalizeCwd(session.cwd);
		let group = groups.get(key);
		if (!group) {
			group = { key, cwd: key, sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	}
	const result = [...groups.values()];
	for (const group of result) group.sessions.sort(byActivity);
	result.sort((a, b) => activity(b.sessions[0]) - activity(a.sessions[0]) || a.key.localeCompare(b.key));
	return result;
}

/**
 * Rows that survive a collapse: every hot/warm session plus the group's newest
 * session even when it is cold. `keepActive` false removes the exemption.
 */
export function pinnedSessions(group, keepActive = true) {
	const sessions = group?.sessions ?? [];
	if (!keepActive || sessions.length === 0) return [];
	const newest = sessions[0];
	return sessions.filter((session) => session === newest || isActiveSession(session));
}

/** Rows a group shows in its current state, plus how many the collapse hides. */
export function groupView(group, collapsed, keepActive = true) {
	const sessions = group?.sessions ?? [];
	if (!collapsed) return { rows: sessions, hidden: 0 };
	const rows = pinnedSessions(group, keepActive);
	return { rows, hidden: sessions.length - rows.length };
}

/** Header count, e.g. "12 sessions · 5 hidden". */
export function countLabel(count, hidden = 0) {
	const sessions = `${count} session${count === 1 ? "" : "s"}`;
	return hidden > 0 ? `${sessions} · ${hidden} hidden` : sessions;
}

/** Home-shortened group title; a missing cwd gets the single fallback label. */
export function groupLabel(group, home) {
	return group?.key ? formatCwd(group.key, home) : "unknown cwd";
}

/** The group's git branch, if the hub reported one for any session in it. */
export function groupBranch(group) {
	for (const session of group?.sessions ?? []) {
		if (typeof session?.branch === "string" && session.branch.trim()) return session.branch.trim();
	}
	return "";
}

/** Stored collapse map: only boolean values survive, malformed input is empty. */
export function parseCollapsed(raw) {
	if (typeof raw !== "string" || raw === "") return {};
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const result = {};
		for (const [key, collapsed] of Object.entries(value)) {
			if (typeof collapsed === "boolean") result[key] = collapsed;
		}
		return result;
	} catch {
		return {};
	}
}

export function serializeCollapsed(map) {
	const clean = {};
	for (const [key, collapsed] of Object.entries(map ?? {})) {
		if (typeof collapsed === "boolean") clean[key] = collapsed;
	}
	return JSON.stringify(clean);
}

/** Pinning is on unless the stored value explicitly says off. */
export function parseKeepActive(raw) {
	if (raw === "0" || raw === "false") return false;
	return true;
}

export function serializeKeepActive(value) {
	return value ? "1" : "0";
}

// Pure dashboard view model: no DOM, HTTP or kernel state. The DOM modules
// (dashboardList, dashboardPicker, dashboardSettings) call these and paint.
import { filterDirEntries, parentDirectory } from "./directoryPicker.js";
import { relativeTime } from "./render.js";
import { groupLabel, groupView } from "./sessionGroups.js";

/** Keep a cwd the user is typing when a list refresh repaints the form. */
export function draftInputValue(draft, fallback) {
	return draft !== undefined ? draft : (fallback ?? "");
}

/** Stopped sessions the bulk-archive action would hide. */
export function inactiveSessions(sessions) {
	return Array.isArray(sessions) ? sessions.filter((session) => session.state === "stopped") : [];
}

/** Collapse state plus whether a toggle would actually hide a row. */
export function groupDisplay(group, collapsed, keepActive) {
	return {
		view: groupView(group, collapsed, keepActive),
		canToggle: groupView(group, true, keepActive).hidden > 0,
	};
}

/** Rendering plan for the directory picker's loaded/loading/error states. */
export function pickerPlan(pickerState, home) {
	if (pickerState.loading) {
		return { loading: true, error: null, parent: null, entries: [], message: "loading…" };
	}
	const listing = pickerState.listing;
	if (!listing) {
		return {
			loading: false,
			error: pickerState.notice || null,
			parent: null,
			entries: [],
			message: "no directory loaded",
		};
	}
	const entries = filterDirEntries(listing.entries, pickerState.filter);
	return {
		loading: false,
		error: pickerState.notice || null,
		parent: parentDirectory(listing.path, listing.home ?? home),
		entries,
		message: entries.length === 0 ? (pickerState.filter ? "no matching directories" : "no subdirectories") : null,
	};
}

/** Title, hint, empty text and row labels for the archived/trash sheet. */
export function storedSheetModel(kind, items, home) {
	const archived = kind === "archive";
	const safe = Array.isArray(items) ? items : [];
	return {
		archived,
		title: `${archived ? "archived" : "trash"} (${safe.length})`,
		hint: archived
			? "Restore a session to the dashboard, or delete its files permanently."
			: "Deleted sessions stay here briefly; undo from the toast or restore below.",
		empty: safe.length === 0 ? (archived ? "nothing archived" : "trash is empty") : null,
		rows: safe.map((item) => ({
			name: item.name ?? String(item.id ?? "").slice(0, 8),
			meta: `${groupLabel({ key: item.cwd, cwd: item.cwd }, home)} · ${relativeTime(item.lastActivity)}`,
		})),
	};
}

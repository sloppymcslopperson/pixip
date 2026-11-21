// Pure state for Pi's fire-and-forget extension UI (`setStatus` / `setWidget`).
// Maps preserve first-seen key order; updates replace in place; an omitted or
// empty value clears that key. The browser and node --test share this file.

export function createAddonUi() {
	return { statuses: new Map(), widgets: new Map() };
}

/** Apply one extension_ui_request. Returns true when it affected addon UI. */
export function applyAddonUi(state, request) {
	if (!state || !request || typeof request !== "object") return false;
	if (request.method === "setStatus") {
		const key = typeof request.statusKey === "string" ? request.statusKey : "";
		if (!key) return false;
		if (typeof request.statusText === "string" && request.statusText.length > 0) {
			state.statuses.set(key, request.statusText);
		} else {
			state.statuses.delete(key);
		}
		return true;
	}
	if (request.method === "setWidget") {
		const key = typeof request.widgetKey === "string" ? request.widgetKey : "";
		if (!key) return false;
		const lines = Array.isArray(request.widgetLines)
			? request.widgetLines.filter((line) => typeof line === "string")
			: [];
		if (lines.length === 0) {
			state.widgets.delete(key);
		} else {
			state.widgets.set(key, {
				placement: request.widgetPlacement === "belowEditor" ? "below" : "above",
				lines,
			});
		}
		return true;
	}
	return false;
}

/** Status texts in first-seen order, joined for the single footer row. */
export function addonStatusText(state) {
	return [...state.statuses.values()].join(" · ");
}

/** Widgets for one placement, in first-seen key order. */
export function addonWidgets(state, placement) {
	return [...state.widgets.entries()]
		.filter(([, widget]) => widget.placement === placement)
		.map(([key, widget]) => ({ key, lines: widget.lines }));
}

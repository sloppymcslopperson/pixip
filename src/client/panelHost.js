// Generic inline panel host. The host knows nothing about A2UI: a renderer
// registers a mount function here (normally a lazily imported module), and the
// host owns the frame, queue, collapse and cancellation in surface.js.
//
// Renderer contract:
//   registerPanelRenderer({ modes?: string[], mount(payload, api) })
//   mount() -> { snapshot?(), restore?(state), destroy?() } | undefined
//   api: { container, submit(value), cancel(), setTitle(text), save() }
//
// No renderer is imported at startup. With no renderer, or a payload the
// renderer rejects/throws on, the host renders a visible fallback card.
const STORAGE_PREFIX = "pixip.panel.";

let renderer = null;
const pending = new Map();

function normalize(candidate) {
	if (typeof candidate === "function") return { mount: candidate };
	if (candidate && typeof candidate.mount === "function") return candidate;
	return null;
}

export function registerPanelRenderer(candidate) {
	const next = normalize(candidate);
	if (!next) throw new Error("panel renderer needs a mount(payload, api) function");
	const previous = renderer;
	renderer = next;
	for (const entry of pending.values()) {
		const draft = snapshot(entry);
		entry.render(draft);
	}
	return () => {
		if (renderer !== next) return;
		renderer = previous;
		for (const entry of pending.values()) entry.render();
	};
}

export function panelTitle(payload) {
	const title = payload?.title;
	return typeof title === "string" && title.trim() ? title.trim() : "Extension panel";
}

export function panelMode(payload) {
	return typeof payload?.mode === "string" && payload.mode.trim() ? payload.mode.trim() : "inline";
}

export function selectPanelRenderer(mode) {
	if (!renderer) return null;
	if (Array.isArray(renderer.modes) && !renderer.modes.includes(mode)) return null;
	return renderer;
}

export function hasPanelRenderer(mode = "inline") {
	return selectPanelRenderer(mode) !== null;
}

function readDraft(id) {
	try {
		const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${id}`);
		return raw === null ? undefined : JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function writeDraft(id, value) {
	try {
		sessionStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(value));
	} catch {
		// private mode or quota: drafts are best-effort, the panel still works
	}
}

function dropDraft(id) {
	try {
		sessionStorage.removeItem(`${STORAGE_PREFIX}${id}`);
	} catch {
		// ignore storage failures
	}
}

function snapshot(entry) {
	try {
		return typeof entry.cleanup?.snapshot === "function" ? entry.cleanup.snapshot() : undefined;
	} catch {
		return undefined;
	}
}

function fallback(body, api, id, mode) {
	const card = document.createElement("div");
	card.className = "panel-fallback";
	const title = document.createElement("div");
	title.className = "panel-fallback-title";
	title.textContent = "This panel cannot be shown yet";
	const detail = document.createElement("div");
	detail.className = "panel-fallback-detail";
	detail.textContent = `No renderer for “${mode}” is loaded. Request ${id}.`;
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "primary";
	cancel.textContent = "cancel request";
	cancel.addEventListener("click", () => api.cancel());
	card.append(title, detail, cancel);
	body.append(card);
}

function mountEntry(entry, draftOverride) {
	const { body, api, id, payload } = entry;
	try {
		entry.cleanup?.destroy?.();
	} catch {
		// a renderer that fails to clean up must not block the next mount
	}
	entry.cleanup = null;
	body.textContent = "";
	const mode = panelMode(payload);
	const selected = selectPanelRenderer(mode);
	if (!selected) {
		fallback(body, api, id, mode);
		return;
	}
	try {
		const result = selected.mount(payload, api) ?? {};
		entry.cleanup = result;
		const draft = draftOverride !== undefined ? draftOverride : readDraft(id);
		if (draft !== undefined) result.restore?.(draft);
	} catch (error) {
		console.error(`panel renderer failed for ${id}`, error);
		entry.cleanup = null;
		body.textContent = "";
		fallback(body, api, id, mode);
	}
}

/** Mount a pending panel in the surface body. Returns its request id. */
export function openPanel(request, body, api) {
	const id = typeof request?.id === "string" ? request.id : "";
	if (!id) throw new Error("panel request needs an id");
	closePanel(id, { discard: false });
	const entry = {
		id,
		payload: request.payload ?? {},
		body,
		api,
		cleanup: null,
		render: (draft) => mountEntry(entry, draft),
	};
	entry.save = () => {
		const draft = snapshot(entry);
		if (draft !== undefined) writeDraft(id, draft);
	};
	entry.onInput = () => entry.save();
	entry.api = { ...api, container: body, save: () => entry.save() };
	pending.set(id, entry);
	entry.render();
	body.addEventListener("input", entry.onInput);
	body.addEventListener("change", entry.onInput);
	return id;
}

/** Remove a panel. `discard` drops its draft; otherwise it is kept for replay. */
export function closePanel(id, { discard = false } = {}) {
	const entry = pending.get(id);
	if (!entry) {
		if (discard) dropDraft(id);
		return;
	}
	const draft = snapshot(entry);
	if (discard) dropDraft(id);
	else if (draft !== undefined) writeDraft(id, draft);
	entry.body.removeEventListener("input", entry.onInput);
	entry.body.removeEventListener("change", entry.onInput);
	try {
		entry.cleanup?.destroy?.();
	} catch {
		// ignore
	}
	entry.cleanup = null;
	entry.body.textContent = "";
	pending.delete(id);
}

export function closeAllPanels({ discard = false } = {}) {
	for (const id of [...pending.keys()]) closePanel(id, { discard });
}

export function pendingPanels() {
	return [...pending.keys()];
}

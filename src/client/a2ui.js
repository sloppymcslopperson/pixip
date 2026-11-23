// A2UI panel renderer adapter. This is the only module that knows about the
// vendored A2UI bundle: the panel host registers it for the "a2ui" mode, and a
// future renderer can replace it without touching surface.js or panelHost.js.
//
// The lifecycle helpers are injectable so node tests can drive them with fakes;
// nothing here touches the DOM until mount() runs in a browser.
import { registerPanelRenderer } from "./panelHost.js";

export const A2UI_MODE = "a2ui";
const DEFAULT_SURFACE_ID = "inline";

/** Ordered A2UI v1.0 messages from the opaque panel payload. */
export function panelMessages(payload) {
	const messages = Array.isArray(payload) ? payload : payload?.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new Error("A2UI panel payload needs a non-empty messages array");
	}
	return messages;
}

/** Explicit surface id, else the first createSurface message, else a default. */
export function panelSurfaceId(payload) {
	const explicit = payload?.surfaceId;
	if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
	for (const message of panelMessages(payload)) {
		const id = message?.createSurface?.surfaceId;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	return DEFAULT_SURFACE_ID;
}

function componentsOf(message) {
	const components = message?.createSurface?.components ?? message?.updateComponents?.components;
	return Array.isArray(components) ? components : [];
}

/** Remove an in-panel Text node that repeats the surface header title. */
export function stripDuplicateTitle(messages, title) {
	const wanted = typeof title === "string" ? title.trim() : "";
	if (!wanted) return messages;
	const removed = new Set();
	let changed = false;
	const next = messages.map((message) => {
		const created = message?.createSurface;
		const updated = message?.updateComponents;
		const target = created ?? updated;
		const components = target?.components;
		if (!Array.isArray(components)) return message;
		const kept = components.filter((component) => {
			const duplicate =
				component?.component === "Text" && typeof component.text === "string" && component.text.trim() === wanted;
			if (duplicate && typeof component.id === "string") removed.add(component.id);
			return !duplicate;
		});
		if (kept.length === components.length) return message;
		changed = true;
		const without = kept.map((component) => {
			if (!Array.isArray(component?.children)) return component;
			const children = component.children.filter((id) => !removed.has(id));
			return children.length === component.children.length ? component : { ...component, children };
		});
		return {
			...message,
			...(created ? { createSurface: { ...created, components: without } } : {}),
			...(updated ? { updateComponents: { ...updated, components: without } } : {}),
		};
	});
	return changed ? next : messages;
}

export function componentTypes(messages) {
	const types = new Set();
	for (const message of messages) {
		for (const component of componentsOf(message)) {
			if (typeof component?.component === "string") types.add(component.component);
		}
	}
	return [...types];
}

function knownTypes(catalog) {
	if (catalog instanceof Map) return new Set(catalog.keys());
	if (catalog instanceof Set) return catalog;
	const components = catalog?.components;
	if (components instanceof Map) return new Set(components.keys());
	if (components instanceof Set) return components;
	if (Array.isArray(components)) return new Set(components);
	if (components && typeof components === "object") return new Set(Object.keys(components));
	return new Set();
}

/** Component types the catalog cannot render. */
export function unknownComponents(messages, catalog) {
	const known = knownTypes(catalog);
	return componentTypes(messages).filter((type) => !known.has(type));
}

export function actionJson(action) {
	return JSON.stringify(action);
}

function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function defaultFallback(container, { title, detail, types, cancel }) {
	const card = document.createElement("div");
	card.className = "panel-fallback";
	const heading = document.createElement("div");
	heading.className = "panel-fallback-title";
	heading.textContent = title;
	const text = document.createElement("div");
	text.className = "panel-fallback-detail";
	text.textContent = types?.length ? `${detail} (${types.join(", ")})` : detail;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "primary";
	button.textContent = "cancel request";
	button.addEventListener("click", cancel);
	card.append(heading, text, button);
	container.append(card);
}

/**
 * Build the A2UI adapter from a loaded bundle (or fakes).
 *
 * mount() returns the panel host's cleanup contract: { snapshot, restore,
 * destroy }. Actions from the surface go back through api.submit as the action
 * JSON string.
 */
export function createA2uiRenderer({
	MessageProcessor,
	catalog,
	createSurfaceElement,
	renderFallback = defaultFallback,
	onError = (error) => console.error("A2UI panel failed", error),
} = {}) {
	if (typeof MessageProcessor !== "function") throw new Error("A2UI renderer needs a MessageProcessor");
	if (typeof createSurfaceElement !== "function") {
		throw new Error("A2UI renderer needs a createSurfaceElement function");
	}
	return {
		modes: [A2UI_MODE],
		mount(payload, api) {
			let processor = null;
			let element = null;
			let surface = null;
			let destroyed = false;
			const subscriptions = [];

			const teardown = () => {
				for (const subscription of subscriptions.splice(0)) {
					try {
						subscription?.unsubscribe?.();
					} catch {
						// a processor that fails to unsubscribe must not block teardown
					}
				}
				try {
					element?.remove?.();
				} catch {
					// ignore
				}
				processor?.dispose?.();
				element = null;
				surface = null;
			};

			const fallback = (title, detail, types = []) => {
				if (destroyed) return;
				teardown();
				api.container.textContent = "";
				renderFallback(api.container, { title, detail, types, cancel: api.cancel });
			};

			const showSurface = (next) => {
				if (destroyed) return;
				surface = next;
				if (!element) {
					element = createSurfaceElement();
					api.container.append(element);
				}
				element.surface = next;
			};

			let unknown = [];
			try {
				const messages = stripDuplicateTitle(panelMessages(payload), payload?.title);
				const surfaceId = panelSurfaceId(payload);
				unknown = unknownComponents(messages, catalog);
				if (unknown.length > 0) {
					fallback("This panel uses components this renderer does not have", "Unknown A2UI component types", unknown);
					return { destroy: teardown };
				}
				processor = new MessageProcessor([catalog], (action) => api.submit(actionJson(action)));
				subscriptions.push(
					processor.onSurfaceCreated((created) => {
						if (created.id === surfaceId) showSurface(created);
					}),
					processor.onSurfaceDeleted((id) => {
						if (id === surfaceId && !destroyed) fallback("This panel was closed", "The surface was deleted");
					}),
				);
				processor.processMessages(messages);
				const existing = processor.getSurface(surfaceId);
				if (existing) showSurface(existing);
			} catch (error) {
				onError(error);
				fallback("This panel could not be rendered", String(error?.message ?? error), unknown);
			}

			return {
				snapshot() {
					try {
						return clone(surface?.dataModel?.get?.("/"));
					} catch {
						return undefined;
					}
				},
				restore(state) {
					if (state === undefined || !surface?.dataModel?.set) return;
					try {
						surface.dataModel.set("/", clone(state));
					} catch {
						// a stale draft must not break the panel
					}
				},
				destroy() {
					destroyed = true;
					teardown();
					api.container.textContent = "";
				},
			};
		},
	};
}

function defaultLoading(container) {
	const note = document.createElement("div");
	note.className = "a2ui-loading";
	note.textContent = "Loading panel…";
	container.append(note);
}

function defaultFailure(container, error, api) {
	const card = document.createElement("div");
	card.className = "panel-fallback";
	const heading = document.createElement("div");
	heading.className = "panel-fallback-title";
	heading.textContent = "This panel could not be loaded";
	const detail = document.createElement("div");
	detail.className = "panel-fallback-detail";
	detail.textContent = String(error?.message ?? error);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "primary";
	button.textContent = "cancel request";
	button.addEventListener("click", api.cancel);
	card.append(heading, detail, button);
	container.append(card);
}

/**
 * Panel-host renderer that imports the vendored bundle on the first A2UI panel.
 * Until the import resolves it shows a loading note, so page load never pays for
 * the renderer.
 */
export function createLazyA2uiPanel({
	loadBundle,
	createRenderer,
	renderLoading = defaultLoading,
	renderFailure = defaultFailure,
} = {}) {
	let adapter = null;
	let pending = null;
	const ensure = () => {
		if (adapter) return Promise.resolve(adapter);
		pending ??= Promise.resolve()
			.then(loadBundle)
			.then((bundle) => {
				adapter = createRenderer(bundle);
				return adapter;
			})
			.catch((error) => {
				pending = null;
				throw error;
			});
		return pending;
	};
	return {
		modes: [A2UI_MODE],
		mount(payload, api) {
			let cancelled = false;
			let inner = null;
			if (adapter) return adapter.mount(payload, api);
			api.container.textContent = "";
			renderLoading(api.container, payload);
			ensure()
				.then((ready) => {
					if (cancelled) return;
					api.container.textContent = "";
					inner = ready.mount(payload, api);
				})
				.catch((error) => {
					if (cancelled) return;
					api.container.textContent = "";
					renderFailure(api.container, error, api);
				});
			return {
				destroy() {
					cancelled = true;
					inner?.destroy?.();
				},
			};
		},
	};
}

function bundleRenderer(bundle) {
	if (typeof document !== "undefined") bundle.injectBasicCatalogStyles?.(document);
	return createA2uiRenderer({
		MessageProcessor: bundle.MessageProcessor,
		catalog: bundle.basicCatalog,
		createSurfaceElement() {
			const wrapper = document.createElement("div");
			wrapper.className = "a2ui-root";
			const element = document.createElement("a2ui-surface");
			wrapper.append(element);
			// The host appends the returned node directly, so it is the wrapper
			// element with a surface accessor rather than a plain adapter object.
			Object.defineProperty(wrapper, "surface", {
				get: () => element.surface,
				set: (value) => {
					element.surface = value;
				},
			});
			return wrapper;
		},
	});
}

let unregister = null;

/** Register the A2UI adapter with the inline panel host (idempotent). */
export function registerA2uiPanel({
	loadBundle = () => import("./vendor/a2ui.esm.js"),
	createRenderer = bundleRenderer,
} = {}) {
	if (unregister) return unregister;
	const off = registerPanelRenderer(createLazyA2uiPanel({ loadBundle, createRenderer }));
	unregister = () => {
		off();
		unregister = null;
	};
	return unregister;
}

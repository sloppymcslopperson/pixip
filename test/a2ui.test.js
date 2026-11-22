import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
	actionJson,
	componentTypes,
	createA2uiRenderer,
	createLazyA2uiPanel,
	panelMessages,
	panelSurfaceId,
	unknownComponents,
} from "../src/client/a2ui.js";
import { hasPanelRenderer } from "../src/client/panelHost.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const catalog = new Map([
	["Text", {}],
	["Row", {}],
	["Column", {}],
	["Tabs", {}],
	["ChoicePicker", {}],
	["TextField", {}],
	["Button", {}],
]);

function messages(components = [{ id: "root", component: "Text", text: "hi" }], surfaceId = "s1") {
	return [{ version: "1.0", createSurface: { surfaceId, catalogId: "catalog", components } }];
}

function fakeModel(initial = {}) {
	let data = structuredClone(initial);
	return {
		get(path) {
			if (path === "/" || path === "") return data;
			return path
				.split("/")
				.filter(Boolean)
				.reduce((current, key) => current?.[key], data);
		},
		set(path, value) {
			if (path === "/" || path === "") data = structuredClone(value);
			return this;
		},
	};
}

function fakeProcessorClass() {
	class FakeProcessor {
		constructor(catalogs, actionHandler) {
			this.catalogs = catalogs;
			this.actionHandler = actionHandler;
			this.surfaces = new Map();
			this.created = [];
			this.deleted = [];
			this.disposed = false;
			FakeProcessor.latest = this;
		}
		onSurfaceCreated(handler) {
			this.created.push(handler);
			return { unsubscribe: () => this.created.splice(this.created.indexOf(handler), 1) };
		}
		onSurfaceDeleted(handler) {
			this.deleted.push(handler);
			return { unsubscribe: () => this.deleted.splice(this.deleted.indexOf(handler), 1) };
		}
		getSurface(id) {
			return this.surfaces.get(id);
		}
		processMessages(list) {
			for (const message of list) {
				const created = message?.createSurface;
				if (!created) continue;
				const surface = { id: created.surfaceId, dataModel: fakeModel(created.dataModel) };
				this.surfaces.set(surface.id, surface);
				for (const handler of this.created) handler(surface);
			}
		}
		dispose() {
			this.disposed = true;
		}
	}
	return {
		FakeProcessor,
		get instance() {
			return FakeProcessor.latest ?? null;
		},
	};
}

function container() {
	return {
		textContent: "",
		children: [],
		append(element) {
			this.children.push(element);
		},
	};
}

function surfaceElement() {
	return {
		surface: null,
		removed: false,
		remove() {
			this.removed = true;
		},
	};
}

function renderer(overrides = {}) {
	const factory = fakeProcessorClass();
	const element = surfaceElement();
	const render = createA2uiRenderer({
		MessageProcessor: factory.FakeProcessor,
		catalog,
		createSurfaceElement: () => element,
		...overrides,
	});
	return { render, element, processor: () => factory.instance };
}

describe("a2ui payload helpers", () => {
	it("accepts an object payload or a bare message array and rejects empty input", () => {
		const list = messages();
		assert.equal(panelMessages({ messages: list }), list);
		assert.equal(panelMessages(list), list);
		assert.throws(() => panelMessages({}), /messages array/);
		assert.throws(() => panelMessages({ messages: [] }), /messages array/);
	});

	it("derives the surface id from the payload or the createSurface message", () => {
		assert.equal(panelSurfaceId({ surfaceId: "explicit", messages: messages() }), "explicit");
		assert.equal(panelSurfaceId({ messages: messages(undefined, "from-message") }), "from-message");
		assert.equal(panelSurfaceId({ messages: [{ version: "1.0", updateComponents: {} }] }), "inline");
	});

	it("collects component types across create and update messages", () => {
		const list = [
			...messages([
				{ id: "root", component: "Column" },
				{ id: "text", component: "Text" },
			]),
			{ version: "1.0", updateComponents: { surfaceId: "s1", components: [{ id: "b", component: "Button" }] } },
		];
		assert.deepEqual(componentTypes(list), ["Column", "Text", "Button"]);
	});

	it("reports only component types the catalog does not know", () => {
		assert.deepEqual(unknownComponents(messages(), catalog), []);
		assert.deepEqual(
			unknownComponents(
				messages([
					{ id: "root", component: "Text" },
					{ id: "x", component: "Widget" },
				]),
				catalog,
			),
			["Widget"],
		);
	});

	it("serializes an action as JSON the extension can parse", () => {
		assert.equal(actionJson({ name: "submit", context: { a: 1 } }), '{"name":"submit","context":{"a":1}}');
	});
});

describe("a2ui renderer lifecycle", () => {
	it("mounts the surface, forwards actions, snapshots and restores drafts", () => {
		const { render, element } = renderer();
		const box = container();
		const submitted = [];
		const handle = render.mount(
			{
				messages: messages(undefined, "s1").map((message) => ({
					...message,
					createSurface: { ...message.createSurface, dataModel: { answers: { color: [] } } },
				})),
			},
			{ container: box, submit: (value) => submitted.push(value), cancel: () => {} },
		);

		assert.equal(element.surface.id, "s1");
		assert.deepEqual(box.children, [element]);
		assert.deepEqual(handle.snapshot(), { answers: { color: [] } });

		handle.restore({ answers: { color: ["red"] } });
		assert.deepEqual(handle.snapshot(), { answers: { color: ["red"] } });

		handle.destroy();
		assert.equal(element.removed, true);
		assert.equal(box.textContent, "");
	});

	it("passes a surface action to submit as the action JSON string", () => {
		const { render, processor } = renderer();
		const submitted = [];
		render.mount(
			{ messages: messages() },
			{ container: container(), submit: (value) => submitted.push(value), cancel: () => {} },
		);
		processor().actionHandler({ name: "submit", surfaceId: "s1", context: { a: 1 } });
		assert.deepEqual(submitted, ['{"name":"submit","surfaceId":"s1","context":{"a":1}}']);
	});

	it("shows a visible fallback listing unknown components instead of mounting", () => {
		const fallbacks = [];
		const { render } = renderer({ renderFallback: (_box, info) => fallbacks.push(info) });
		render.mount(
			{
				messages: messages([
					{ id: "root", component: "Text" },
					{ id: "w", component: "Widget" },
				]),
			},
			{ container: container(), submit: () => {}, cancel: () => {} },
		);
		assert.equal(fallbacks.length, 1);
		assert.deepEqual(fallbacks[0].types, ["Widget"]);
		assert.equal(fallbacks[0].cancel instanceof Function, true);
	});

	it("falls back on a processor error and reports it", () => {
		const errors = [];
		const fallbacks = [];
		class Failing {
			onSurfaceCreated() {
				return { unsubscribe() {} };
			}
			onSurfaceDeleted() {
				return { unsubscribe() {} };
			}
			processMessages() {
				throw new Error("bad message");
			}
			dispose() {}
		}
		const render = createA2uiRenderer({
			MessageProcessor: Failing,
			catalog,
			createSurfaceElement: () => surfaceElement(),
			renderFallback: (_box, info) => fallbacks.push(info),
			onError: (error) => errors.push(error.message),
		});
		render.mount({ messages: messages() }, { container: container(), submit: () => {}, cancel: () => {} });
		assert.deepEqual(errors, ["bad message"]);
		assert.equal(fallbacks.length, 1);
		assert.match(fallbacks[0].detail, /bad message/);
	});
});

describe("lazy a2ui panel", () => {
	it("shows loading, then mounts once the bundle resolves", async () => {
		let resolveBundle;
		const loading = [];
		const mounted = [];
		const panel = createLazyA2uiPanel({
			loadBundle: () => new Promise((resolve) => (resolveBundle = resolve)),
			createRenderer: () => ({
				mount(payload, api) {
					mounted.push(payload);
					api.container.textContent = "mounted";
					return { destroy() {} };
				},
			}),
			renderLoading: (box) => loading.push(box),
			renderFailure: () => assert.fail("should not fail"),
		});

		const box = container();
		panel.mount({ messages: messages() }, { container: box, submit: () => {}, cancel: () => {} });
		assert.equal(loading.length, 1);
		await settle();
		resolveBundle({});
		await settle();
		assert.equal(mounted.length, 1);
		assert.equal(box.textContent, "mounted");
	});

	it("renders a failure when the bundle cannot load", async () => {
		const failures = [];
		const panel = createLazyA2uiPanel({
			loadBundle: () => Promise.reject(new Error("offline")),
			createRenderer: () => assert.fail("should not build a renderer"),
			renderLoading: () => {},
			renderFailure: (_box, error) => failures.push(error.message),
		});
		panel.mount({ messages: messages() }, { container: container(), submit: () => {}, cancel: () => {} });
		await settle();
		assert.deepEqual(failures, ["offline"]);
	});

	it("does not mount after the panel was dismissed while loading", async () => {
		let resolveBundle;
		let mounted = false;
		const panel = createLazyA2uiPanel({
			loadBundle: () => new Promise((resolve) => (resolveBundle = resolve)),
			createRenderer: () => ({
				mount() {
					mounted = true;
					return {};
				},
			}),
			renderLoading: () => {},
			renderFailure: () => assert.fail("should not fail"),
		});
		const handle = panel.mount(
			{ messages: messages() },
			{ container: container(), submit: () => {}, cancel: () => {} },
		);
		handle.destroy();
		await settle();
		resolveBundle({});
		await settle();
		assert.equal(mounted, false);
	});
});

describe("a2ui registration", () => {
	it("claims only the a2ui mode and unregisters cleanly", async () => {
		const { registerA2uiPanel } = await import("../src/client/a2ui.js");
		const unregister = registerA2uiPanel({
			loadBundle: () => Promise.resolve({}),
			createRenderer: () => ({ mount: () => ({}) }),
		});
		assert.equal(hasPanelRenderer("a2ui"), true);
		assert.equal(hasPanelRenderer("inline"), false);
		unregister();
		assert.equal(hasPanelRenderer("a2ui"), false);
	});
});

it("the committed fixture only uses catalog components", async () => {
	const raw = await readFile(new URL("./fixtures/a2ui-panel.json", import.meta.url), "utf8");
	const payload = JSON.parse(raw);
	const list = panelMessages(payload);
	assert.deepEqual(unknownComponents(list, catalog), []);
	assert.deepEqual(componentTypes(list), ["Column", "Text", "Tabs", "ChoicePicker", "TextField", "Row", "Button"]);
});

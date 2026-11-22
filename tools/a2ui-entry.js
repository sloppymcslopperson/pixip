// Entry point for the vendored A2UI browser bundle. Built by
// tools/build-a2ui.mjs into src/client/vendor/a2ui.esm.js; never served or
// imported directly by the client.
import { A2uiSurface } from "@a2ui/lit";
import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog, injectBasicCatalogStyles } from "@a2ui/web_core/catalogs/basic/v1";
import { registerUniversalElement } from "@a2ui/web_core/universal";
import { css } from "lit";

// Local patch: a Tabs component must not size its host to the tab bar's
// max-content width. The tab bar scrolls horizontally and the content stays in
// the panel (see src/client/vendor/a2ui.README.md).
const tabsLayoutStyles = css`
	:host {
		display: block;
		width: 100%;
		min-width: 0;
	}
	.a2ui-tabs {
		min-width: 0;
	}
	.a2ui-tab-bar {
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: thin;
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--a2ui-color-background, #fff);
	}
	.a2ui-tab-button {
		flex: 0 0 auto;
		white-space: nowrap;
	}
	.a2ui-tab-content {
		min-width: 0;
		overflow-x: hidden;
	}
`;

function patchTabsLayout(component) {
	if (component.tagName !== "a2ui-tabs") return;
	const original = component.element.styles;
	component.element.styles = css`
		${original}
		${tabsLayoutStyles}
	`;
}

// The v1.0 basic catalog ships Web Component implementations, not registered
// elements, so register them once here instead of at each mount.
for (const component of basicCatalog.components.values()) {
	patchTabsLayout(component);
	registerUniversalElement(component);
}

export { A2uiSurface, MessageProcessor, basicCatalog, injectBasicCatalogStyles };

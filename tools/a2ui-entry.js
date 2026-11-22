// Entry point for the vendored A2UI browser bundle. Built by
// tools/build-a2ui.mjs into src/client/vendor/a2ui.esm.js; never served or
// imported directly by the client.
import { A2uiSurface } from "@a2ui/lit";
import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog, injectBasicCatalogStyles } from "@a2ui/web_core/catalogs/basic/v1";
import { registerUniversalElement } from "@a2ui/web_core/universal";

// The v1.0 basic catalog ships Web Component implementations, not registered
// elements, so register them once here instead of at each mount.
for (const component of basicCatalog.components.values()) registerUniversalElement(component);

export { A2uiSurface, MessageProcessor, basicCatalog, injectBasicCatalogStyles };

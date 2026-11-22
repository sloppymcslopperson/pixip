---
project: pixip
grilled: true
commit: "6e795e0e3deddc01935c7dd7ac9e4719d53ff92b"
---

Render A2UI v1.0 surfaces from an opaque `panel` request into the inline panel host added by `03-panel-host`, and send the user's action back as the panel response. Vendor the official `@a2ui/lit` + `@a2ui/web_core` v1.0 renderer as one lazy-loaded browser asset; keep the hub a passthrough. This ticket does not add A2UI history or transcript rendering.

### Decisions

- Renderer: official A2UI v1.0 Lit renderer with the Basic catalog; measured ~490 KB minified / ~140 KB gzip as a single committed vendor file. Serve as-is (like `vendor/marked.esm.js`) and lazy-import on the first A2UI panel; no runtime build step.
- Transport: the `panel` request from `pixip-pi-host` (`00-pi-host-package`, `01-pi-host-integration`). Payload is an ordered A2UI v1.0 message array plus optional `{surfaceId, title, mode}`. Placement is owned by `03-panel-host`; this ticket renders into that host.
- Response: a JSON string containing the A2UI `action` (`name`, `surfaceId`, `sourceComponentId`, `context`, `timestamp`) or `{cancelled:true}`; the extension parses it.
- Security: only render catalog components; never inject A2UI strings as HTML; sanitize URLs; unknown components get a visible fallback rather than a crash.

### Implementation

- Vendor the renderer and catalog as one committed browser asset, with license/version provenance beside it.
- `src/client/a2ui.js`: pure lifecycle wrapper around `MessageProcessor` (create/update/delete surfaces, process ordered messages, read surface state, serialize actions). Unit-testable without DOM.
- A view adapter registers with the panel host: lazily import the vendored bundle, mount `<a2ui-surface>` into the inline surface, subscribe to surface creation/deletion, and dispatch actions.
- Implement the host's optional draft hooks: persist unsent form state in `sessionStorage` keyed by session + request id, restore on replay, and clear on submit/cancel.
- `02-inline-surface` owns the panel host, collapse/expand, cancellation and the `extension_ui_response` plumbing; do not rebuild those here.
- `src/client/index.html` / `src/client/sheets.css`: panel styling sized for the inline surface and its collapsed/full states; do not duplicate markup per breakpoint.

### Acceptance

- A fixture panel payload renders Text, Column, Tabs, ChoicePicker, TextField and Buttons and can submit an action context containing bound data-model values.
- Reconnect while a panel is pending replays it into the inline surface; the answered panel is not replayed.
- Cancel, submit, collapse/expand and unknown-component paths are covered by tests; `npm run check` green.
- `tools/shot.mjs` at 390 and 1280 shows the panel usable expanded and collapsed on phone and desktop.
- Initial page load is unchanged; the A2UI bundle is fetched only when the first panel arrives.
- `ARCHITECTURE.md` documents the client-side A2UI boundary; the host protocol is documented by the host package and integration ticket.

### Out of scope

- Model-generated A2UI, custom catalogs, `callRendererFunction`/`callAgentFunction`, A2UI in the transcript or session history, and the questionnaire extension. This ticket is the client renderer plus panel registration.

### Grilled decisions

- Seam: `src/client/a2ui.js` is the only module that imports the vendored bundle. It registers through `registerPanelRenderer({ modes: ["a2ui"], mount(payload, api) })` and returns `{snapshot, restore, destroy}`; no Lit, `SurfaceModel` or element references escape it, so `surface.js`, `panelHost.js` and `app.js` stay renderer-agnostic.
- Bundle: pin `@a2ui/web_core@0.15.0` and `@a2ui/lit@0.15.0`. Protocol is `1.0`, the catalog comes from `@a2ui/web_core/catalogs/basic/v1`, and the surface element is `A2uiSurface` from `@a2ui/lit`. Commit one asset under `src/client/vendor/` built by a dev-only `tools/build-a2ui.mjs` using a pinned `npx --yes esbuild@…`; CI needs no bundler. Provenance and license sit beside the asset.
- Payload: `{messages: [...], surfaceId?, title?, mode}`; `mode` defaults to `"a2ui"`; when `surfaceId` is absent it is derived from the `createSurface` message.
- Drafts: reuse the panel host's existing `sessionStorage` keying by request id. No session prefix and no `panelHost.js` change.
- Tests: injectable processor/surface factories in `a2ui.js`, so node tests use fakes for create/update/delete/action/fallback/draft paths. The real bundle is exercised by the dev fixture and `tools/shot.mjs`.
- Fixture: only under `--dev`, opened by `GET /?panel=fixture`, delivered through the normal `extension_ui_request` path so it exercises surface, host and renderer together.
- Unknown components: pre-scan message component types against the v1.0 Basic catalog set and render a visible fallback card listing the unknown types with a cancel action; processor exceptions also fall back instead of blanking the surface.
- Styling: target our own `.a2ui-*` wrapper classes, never vendor element tag names, so a future replacement renderer keeps the CSS.
- Component coverage: ship the official Basic catalog, so the acceptance fixture (Text, Column, Tabs, ChoicePicker, TextField, Button) is a subset.

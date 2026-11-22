---
project: pixip
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

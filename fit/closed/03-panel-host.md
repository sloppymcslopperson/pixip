---
project: pixip
grilled: true
commit: b046a75fe1d8ede6cb69904690420ddeecbca95c
---

Add a generic inline panel host for opaque `panel` extension requests in the collapsible surface, without importing A2UI. The A2UI renderer registers with this host in `04-a2ui-panel-renderer`.

### Host

- `handleUiRequest` recognises `method: "panel"` and mounts the opaque payload into the inline surface from `02-inline-surface`.
- Provide `openPanel`, `closePanel` and a renderer registration point. No A2UI import or bundle request at startup.
- Use the payload's title and mode; default to the inline surface. The host owns the frame, collapse/expand and cancellation.
- If no renderer is registered or a payload is unsupported, show a visible fallback card with a cancel action. Never render a blank surface or throw.
- Keep a pending-panel registry keyed by request id so replay can reattach; remove it on answer or cancel.

### Contract

- `01-pi-host-integration` adds `panel` to the hub's blocking-UI cache and replay path. Do not duplicate hub work here.
- A submitted action is a JSON string in `value`; cancellation is `{cancelled:true}`. Use the existing `ui` frame and send exactly once.
- Define optional `snapshot()` / `restore()` hooks for renderer draft state; the A2UI renderer implements them in `04-a2ui-panel-renderer`.
- A replayed pending panel appears in the inline surface; an answered panel is not replayed.

### Tests

- Fake panel payload: mount, submit, cancel, collapse/expand, reconnect replay, unsupported-renderer fallback.
- Assert the A2UI bundle is not requested before the first panel and no request is made for a fallback-only test.
- `tools/shot.mjs` at 390 and 1280 with the fake panel collapsed and expanded.

### Out of scope

- A2UI message processing, catalog components, the questionnaire extension, A2UI session history, and hub protocol changes beyond confirming `01`.

### Decisions (grilled 2026-11-21)

- **Registration:** direct ES-module export from `src/client/panelHost.js`: `registerPanelRenderer(renderer)`, plus `openPanel(request)` / `closePanel(id)`. The A2UI renderer imports `panelHost.js` and registers itself; no global, no startup import of A2UI.
- **Renderer contract:** `mount(payload, api)` returns optional `{snapshot?, restore?, destroy?}`. `api` exposes `submit(value)` and `cancel()`; the host owns the frame, title, collapse/expand, Replace queue and cancellation footer. `submit` sends exactly one `{t:"ui", id, value}` where `value` is the JSON string; cancel sends `{cancelled:true}`.
- **Title/mode:** read `payload.title` and `payload.mode` inside the opaque payload. Missing title falls back to `Extension panel`; unsupported mode or no renderer shows the visible fallback card with Cancel and does not throw. Never render a blank surface.
- **Draft state:** host snapshots renderer state into `sessionStorage` keyed by request id, restores it when the same pending request remounts after collapse or reload/replay, and clears the key on answer or cancel. `snapshot()`/`restore()` are optional; the host falls back to a fresh mount.
- **Queueing:** panels use the same 02 behavior: one active panel, later panels queued behind a persistent header banner + Replace; answering/cancelling the active panel auto-mounts the next.
- **Registry:** keep pending panels keyed by request id so replay reattaches; remove on answer/cancel. An answered panel is never replayed.
- **Assumption:** renderer registration may happen after a panel request is already pending (lazy import); the host remounts the pending panel when a renderer registers.
- **Assumption:** `payload` stays opaque to the host; the fallback card shows a generic message plus the request id, not the raw payload.

### Acceptance additions

- Registering a renderer after `panel` arrives mounts it without reload; unsupported payload shows the fallback card and a working Cancel.
- Collapse then expand restores the draft via `snapshot`/`restore`; reload while pending restores from `sessionStorage`.
- No A2UI module or bundle is requested before the first panel.

### Verification (2026-11-21)

- `handleUiRequest` routes `panel` into the inline surface; the host owns header/title/mode/collapse/cancel and the Replace queue.
- Renderer registration is a direct module export; no A2UI module or bundle was requested before the panel (browser request log: none) and none for the fallback-only pass.
- Contract note: `api.container` is the surface body element the renderer mounts into; `api.submit`/`cancel`/`setTitle`/`save` are also provided. `openPanel`/`closePanel` and `registerPanelRenderer` live in `src/client/panelHost.js`.
- Fallback: no renderer shows a visible card with the mode, request id and a working cancel; a throwing renderer is caught and replaced by the same card.
- Draft: `snapshot()`/`restore()` plus `api.save()` persist to `sessionStorage` keyed by request id; reload/replay restored `save me`, submit sent `{"text":"save me"}`, cancel sent `{cancelled:true}`, and the draft key was removed afterwards.
- Registration after the panel arrived remounted it without reload; collapse/expand preserved the draft.
- Browser check at 390x844 and 1280x900 (fallback, mounted expanded, collapsed) with no console/page errors. Unit tests: `test/panelHost.test.js` (title/mode defaults, mode-gated registration, bare mount function, invalid renderer). `npm run check` green (243 tests).

---
project: pixip
grilled: true
commit: be3ec4ba09bf6559f564d40938bff18605304386
---

Make the inline panel grow into the available vertical space when its content overflows, instead of sizing to content and leaving usable space above it unused. Keep the collapsed state header-only and keep `#log` the only page-level scroll container.

### Current behaviour

`#surface` is `flex: none` with `max-height: 70%`; a long A2UI questionnaire body scrolls inside a panel that is shorter than the space above the composer. With a tall viewport and a short transcript the owner saw a cramped panel and unused space above it.

### Work

- Let the panel take the available space up to a safe cap: grow with content, then scroll the `.surface-body` internally once the cap is reached. Do not stretch a short panel just to fill space.
- Account for the header, the Replace banner, the composer and the safe-area padding (`--surface-height` / jump-pill offset must stay correct).
- Keep collapsed mode at the header height and keep the transcript scroll position when the panel grows.

### Acceptance

- A long questionnaire panel at 390 and 1280 uses the space above the composer, scrolls internally, and does not scroll the page or the transcript unexpectedly.
- A one-question panel still sizes to its content rather than stretching.
- Collapse/expand, the jump pill and the Replace banner still work; `tools/shot.mjs` shows both widths.

### Files

- `src/client/surface.css` (and `surface.js` only if the height calculation needs a JS hook).
- `tools/shot.mjs` / a long A2UI fixture for the before-and-after shots.

### Grilled decisions

- The "huge gap" above the panel is the bug: the panel must grow until only the session title bar plus a tiny sliver of transcript history remain visible. Cap is viewport-minus-chrome (effectively the `#session` height) minus roughly 2-3rem of transcript, not the old 70% cap.
- The grow-to-cap rule applies to all inline surface methods (select/confirm/input/editor/panel), not only A2UI panels. Short content still sizes to content and does not stretch.
- Implement CSS-only where possible; touch `surface.js` only if a JS height hook is genuinely required.
- Add a separate long A2UI fixture (e.g. `test/fixtures/a2ui-panel-long.json`) with enough questions to overflow, served through the dev fixture path.
- Extend `tools/shot.mjs` metrics with surface height, `surface-body` clientHeight/scrollHeight, and `#log` height so the acceptance is machine-checkable.
- Test evidence is `npm run check` green plus the 390 and 1280 shots/metrics; no new DOM layout unit test.
- Collapsed state stays header-only, the Replace banner and jump-pill offset stay correct, and the transcript scroll position must not jump when the panel grows.

### Verification

- `src/client/surface.css`: `#surface` cap is `calc(100% - 2.5rem)` of `#session` (leaves a 38px transcript sliver) and `.surface-body` is `flex: 0 1 auto` so it scrolls internally at the cap.
- `src/client/surface.js` re-pins `#log` when the panel grows while the transcript is stuck to newest, so growing does not appear to scroll the transcript.
- Long fixture added at `test/fixtures/a2ui-panel-long.json`; dev route accepts `?fixture=long` and the client opens it with `/?panel=long`.
- `tools/shot.mjs` now reports `clientHeight`/`scrollHeight` for `#log` and `#surface`, plus the `#surface .surface-body` box.
- Measured at 390x844: expanded surface 642px, body client 590 vs scroll 848 (internal scroll), `#log` 38px, body does not scroll. Collapsed surface 51px header-only and `#log` grows to 628px.
- Measured at 1280x900: expanded surface 698px, body client 646 vs scroll 792, `#log` 38px, body does not scroll. Collapsed surface 51px.
- Short fixture at 390 stays content-sized at 321px rather than stretching; `tools/shot.mjs` shows both widths.
- `npm run check` green (run with the harness's `PIXIP_INSIDE`/`PIXIP_SESSION_ID` unset so the unrelated daemon tests do not self-restart).

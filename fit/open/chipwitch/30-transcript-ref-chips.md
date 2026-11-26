---
grilled: false
project: pixip
series: chipwitch
---

Render ref tags inside sent user messages as the same chips, so a message carrying a reference reads as a pointer instead of raw brackets, without touching what was sent.

### Decisions

- Display-only: `state.entries` and the JSONL keep the raw tag, which stays greppable and is what the agent sees. The raw form remains reachable from the block's long-press/menu.
- `renderUserBody` (`src/client/render.js`) is the single seam. The text is escaped there, so match the strict pattern against the escaped string and splice chips; no markdown path is involved.
- User messages only. Assistant prose that happens to contain `[ref=…]` stays literal, because a model-emitted tag is not a user reference.
- Optimistic echo and Pi's own echo must render identically.

### Acceptance

- A sent message with one and with several refs renders chips; an unresolved tag renders as literal text.
- Long-press (or the block menu) shows and copies the raw tag.
- Rendering a chip never alters the text that was submitted.
- `npm run check` green, plus shots at 390 and 1280.

### Open

- Whether a resolved chip in the transcript is clickable (scroll to the referenced block in the same session, sheet for another session) or purely informative for now.

### Boundaries

- Display-only. Never rewrite `state.entries`, a socket payload, or the JSONL.
- Scope is `renderUserBody` only: do not touch `renderAssistant`, the markdown path, tool cards, or thinking rendering.
- Do not change what `submitText` sends; the chip decorates the echo, it does not pre-process the prompt.
- Same hot-reload fence as `00-ref-grammar`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `npm run check` green.
- Unit in `test/refs.test.js`: escaping around and inside a tag (`<`, `&`, quotes), a tag embedded in prose, two tags in one line, and a literal `[ref=` fragment that must stay text.
- Manual: optimistic echo and Pi's own echo render identically; a reload keeps the chips; a tag that no longer resolves renders literally.
- `node tools/shot.mjs` at 390 and 1280.

### Browser verification (required)

- `tools/shot.mjs` is a layout probe, not evidence. Send a message containing one tag and one with several tags through the real composer with the **agent-browser** tool against `http://127.0.0.1:8138/`, then reload the page and confirm the chips survive and Pi's echo matches the optimistic one.
- Also paste a tag into a message from another session so the chip resolves through the `sessions` frame path, then a ref that cannot resolve and must render as literal text.
- Scripted coverage in `tools/browser-check.mjs` for the rendering rules; screenshots at 390 and 1280 are supporting evidence, not the test.

  ```bash
  PIXIP_CHROME=$(ls -d ~/.agent-browser/browsers/chrome-*/chrome | tail -1) npm run check:browser
  ```

- `npm run check` silently skips `check:browser` when `PIXIP_CHROME` is unset. Say explicitly which of the two you ran.

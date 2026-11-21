The transcript shows raw markdown (`| tables |`, `**bold**`, backticks) where the TUI renders it.

### Goal

Render assistant and user text as markdown in the client, close to how the TUI shows it, with no build step and no markdown dependency added to the hub.

### Done when

- Headings, bold/italic, inline code, fenced code blocks, lists, blockquotes, links and pipe tables render as HTML in the transcript.
- Inline and fenced code use the same monospace palette as ANSI output; fenced code keeps its content verbatim (no reflow inside `pre`).
- User messages keep `white-space: pre-wrap` semantics for text that is not markdown-shaped (plain one-liners must not gain paragraph margins).
- Streaming stays incremental: text deltas still append to a text node and only the finished message is re-rendered as markdown (re-parsing on every delta is not acceptable).
- `npm run check` passes; add unit tests for the renderer in `test/` (pure functions, no DOM).
- Verify with `tools/shot.mjs` at 390 and 1280 against a session containing a table and a fenced block.

### Files

`src/client/render.js` (renderer + escaping), `src/client/app.js` (call it on `message_end`, not per delta), `src/client/style.css` (markdown styles), `test/`.

### Notes

- Keep the existing HTML escaping discipline: escape first, then apply markup, never the reverse.
- Syntax highlighting and diff colouring are deliberately out of scope here (separate backlog ticket).

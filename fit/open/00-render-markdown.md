The transcript shows raw markdown (`| tables |`, `**bold**`, backticks) where the TUI renders it.

### Goal

Render assistant text as markdown in the client, close to how the TUI shows it, with no build step added to the repo.

### Decisions (owner, 2026-11-21)

- **Vendor a real renderer**: ship one ES module (e.g. `marked`) inside `src/client/`, loaded as a plain module. No bundler, no CDN, no dependency added to the hub or to `package.json` runtime deps.
- **User messages stay literal**: only assistant output is rendered, so what the owner typed is always what is shown.
- GFM extras (tables, task lists) are in scope because the vendored renderer provides them.

### Done when

- Headings, bold/italic, inline code, fenced code blocks, lists, blockquotes, links and pipe tables render as HTML in assistant messages.
- Inline and fenced code use the same monospace palette as ANSI output; fenced code keeps its content verbatim (no reflow inside `pre`).
- User messages keep `white-space: pre-wrap` and are escaped, not rendered.
- Streaming stays incremental: deltas still append to a text node; only the finished message is re-rendered as markdown.
- `npm run check` passes; unit tests cover the renderer (pure functions, no DOM) including HTML-escaping of raw text in the source.
- Verify with `tools/shot.mjs` at 390 and 1280 against a session containing a table and a fenced block.

### Files

`src/client/render.js` (renderer + escaping), `src/client/app.js` (render on `message_end`, not per delta), `src/client/style.css` (markdown styles), `src/client/vendor/` (the vendored module), `test/`.

### Notes

- Escape first, then apply markup; never the reverse.
- Syntax highlighting and diff colouring are out of scope (backlog ticket).

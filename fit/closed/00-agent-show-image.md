---
grilled: true
---

The agent should be able to intentionally show the user one image in the transcript, the way a user-sent image already appears. Today only user messages render image blocks; tool-result images are dropped by the text-only tool renderer.

### Grilled decisions

- **Mechanism**: dedicated display tool, not implicit rendering of every tool-result image. Only `show_image_to_user` results render in pixip.
- **Tool**: `show_image_to_user({ path, caption? })`, absolute paths only; a relative path is a tool error telling the agent to pass an absolute path. One image per call. An optional caption is the text shown with the image.
- **Package**: new `extensions/pixip-show-image` Pi extension package, added to npm workspaces and `npm run check`. Users install it with `pi install ./extensions/pixip-show-image`; the hub does not auto-register it.
- **Formats**: PNG/JPEG/GIF/WebP, detected from the file. Reject anything else and non-files.
- **Size policy**:
  - source <= 1 MB: return the image block unchanged;
  - source > 1 MB and <= 20 MB: downscale to a thumbnail with Pi's public `resizeImage` helper (longest edge 1024 px, <= 512 KB encoded), return that thumbnail, and say the original is over the 1 MB limit with a download link;
  - source > 20 MB: do not read it; return the link/notice only;
  - if resizing fails, return the link/notice only.
  - Pi's own tool-result image normalization still runs after the tool returns.
- **Result text**: optional caption line, then a file link line. Link is `file:///abs/path` in other hosts; for an oversized original the line says it is over the limit and offers the download. The tool returns text before the single image block, like `read`.
- **TUI/other hosts**: return the image normally and include the `file:///abs/path` clickable link in the text; no custom TUI renderer.
- **pixip card**: visible image strip on the tool card (not hidden behind the text toggle), text output collapsible below it. Tap opens the existing image sheet. Images are eager, no `loading="lazy"`; render only the first image. Styling/behavior matches user-message thumbnails.
- **Coverage**: live `tool_execution_end`, reload/reattach snapshots, and the lazy full-entry path. Streaming `tool_execution_update` partials are out of scope.
- **Oversize download in pixip**: the tool returns `file:///abs/path`; the client rewrites it to a session-scoped hub route (assumption: `GET /api/sessions/:id/files?path=<absolute>`, regular files only, supported image MIME, attachment disposition, 100 MB cap) so the browser can actually download the original. The TUI keeps `file://`.
- **Screenshots/capture**: out of scope. This tool only shows an existing image file.
- **Verification**: unit tests for the extension, render/window tests for image tool results, and `tools/shot.mjs` at 390 and 1280 with a real `show_image_to_user` result. Install the package for the real check, then uninstall it after the user confirms so the branch can merge and be installed on main.

### Files

- `extensions/pixip-show-image/` (new package: tool, tests, README)
- `src/client/render.js`, `src/client/transcript.js`, `src/client/transcript.css`
- `src/server.ts` (download route) and any shared path/limis helper
- `test/render.test.js` plus a transcript/live test
- `package.json` workspaces/scripts, root README install note, `docs/TUI-parity.md`

### Acceptance

- A real session can call `show_image_to_user({ path: "/abs/shot.png", caption: "..." })` and the image is visible on the tool card without expanding text.
- Reloading the session still shows it.
- Tapping it opens the same enlarge sheet as a user image.
- A relative path, unsupported file, missing file, or >20 MB file returns a clear tool error/link without breaking the transcript.
- A >1 MB image shows a downscaled thumbnail plus the over-limit/download text.
- The download link works in pixip and is a `file://` link in the TUI.
- `npm run check` is green and the two screenshots are inspected.

### Verification

- `npm run check` green (run with `PIXIP_INSIDE`, `PI_SESSION_FILE` and `PIXIP_SESSION_ID` unset; inside pixip the daemon lifecycle tests see a caller session and fail for that unrelated reason).
- Real session `show_image_to_user({ path: ".../docs/phone-session.png", caption: "Phone session layout" })`: tool result had `details`, a text block and one image block; live event and a fresh snapshot page both rendered the card.
- `tools/shot.mjs` at 390 and 1280: thumbnail visible, `output` folded below it, no console/page errors, no horizontal overflow.
- Tapping and the download route: expanded text showed the caption/size/link; `GET /api/sessions/<id>/files?path=...` returned `200 image/png`, `attachment; filename="phone-session.png"` and the full 43,872 bytes.
- A 1.2 MB padded PNG returned a 473×1024 thumbnail with "over the 1 MB limit" text and a "download original" link.
- Extension unit tests cover relative paths, missing/non-file/unsupported sources, the 1 MB and 20 MB thresholds, resize failure and link-only fallback.
- Commit `763f60e`. The extension is installed in the user's Pi settings for this check and must be removed after confirmation with `pi remove ./extensions/pixip-show-image`.

- User confirmed the worktree-served copy rendered the tool correctly. Extension removed with `pi remove ./extensions/pixip-show-image`; temporary daemons on 8141/8142 stopped. Ready to merge and install on main.

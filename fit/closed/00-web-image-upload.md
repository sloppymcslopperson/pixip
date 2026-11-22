---
grilled: true
leg: dogfooding-test
project: pixip
---

Add an image-upload affordance to the composer so a phone can attach a photo/screenshot to a prompt, with a thumbnail preview and a way to remove it before sending. This closes the "Image paste/attachments" row in `docs/parity.md`.

### Result

Implemented end to end: one pending image or arbitrary file, a `+` menu with photo/camera and file inputs, clipboard paste, inline preview/removal, image downscale, hub validation, a raw upload endpoint for files, prompt path injection, transcript image thumbnails with an enlarge sheet, and upload cleanup. `docs/parity.md`, `README.md` and `ARCHITECTURE.md` are updated.

### RPC findings (Pi 1.5.2)

`pi --mode rpc` accepts `images` on `prompt`, `steer`, and `follow_up`. Each image is `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`. Pi persists the normalized image in the session JSONL, so reattach/replay renders it without re-uploading.

### Decisions

- Sources: `+` menu with "Photo or camera" (`accept="image/*"`, no `capture`) and "Choose file" (`*/*`), plus desktop clipboard paste. The menu is extensible.
- Count: exactly one pending attachment total; picking another replaces it.
- Images: client decodes, downscales to at most 1600 px on the longest edge, encodes JPEG/PNG, rejects originals over 20 MB. Hub rejects non PNG/JPEG/GIF/WebP, decoded data over 8 MB, base64 over ~11 MB, or more than one image.
- Non-image files: `POST /api/sessions/<id>/uploads?name=<filename>` raw bytes, 100 MB cap; stored at `<data-dir>/uploads/<logical-session>/<uuid>-<safe-name>`. Prompt gets a blank line plus `Attached file: <absolute path>`, or just that line for an attachment-only send.
- Lifetime: uploads survive stop/reattach; cleared on `/new`, archive, and trash/delete.
- Image-only prompts are allowed. Builtin commands and `!`/`!!` are blocked while an attachment is pending; plain prompts and passthrough extension commands carry it.
- Busy sends use the existing `prompt` + `streamingBehavior: "steer"` path, so images are not silently dropped.
- Upload UX: "uploading…" chip plus inline error/size text; no progress bar or cancel.

### Implementation

- `src/attachments.ts`: shared image validation, limits and safe upload names.
- `src/hub.ts`: image-aware `prompt`/`steer`, `uploadFile`, upload-dir cleanup on `/new` and store/archive/trash.
- `src/server.ts`: `POST /api/sessions/:id/uploads`, 100 MB streaming cap, images on prompt/steer frames.
- `src/client/attachments.js`: limits, size labels, path-prompt shaping, image detection.
- `src/client/app.js`, `index.html`, `style.css`, `render.js`: `+` menu, paste, preview/error chips, image prepare/upload, send-state, transcript thumbnails and enlarge sheet.
- Tests: `test/attachments.test.ts`, `test/attachments-client.test.js`, `test/render.test.js`; fake Pi logs images on prompt/steer.
- Docs: `docs/parity.md`, `README.md`, `ARCHITECTURE.md`.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID -u PI_SESSION_FILE npm run check`: **232 pass, 0 fail**. (Without unsetting the outer session markers, the two daemon stop tests correctly take the inside-pixip restart path.)
- Fake Pi: socket `prompt` with an image reaches the child, hub/steer images preserve `streamingBehavior`, malformed/oversized/multiple images never reach the child, upload route writes the file, stop keeps it, `/new` and archive remove it.
- Real child: an image-only prompt to real `pi` settled normally; the session JSONL user message contained one image block of 52,163 bytes and no text.
- Visual: Playwright Firefox at 390 and 1280 (Chrome is not installed) with the preview visible, image loaded, send enabled, no horizontal overflow, and a generic file chip reaching “ready”. Firefox deps were loaded from `/tmp/ffdeps`.

### Notes

- The two daemon test failures seen when running inside pixip are environmental (`PIXIP_INSIDE`/`PIXIP_SESSION_ID`/`PI_SESSION_FILE`), not caused by this ticket.
- No commit was made; the working tree also contains unrelated pre-existing changes.

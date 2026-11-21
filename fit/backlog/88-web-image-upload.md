---
blocked_on: rpc-image-support
grilled: false
leg: dogfooding-test
project: pixip
---

Add an image-upload affordance to the composer so a phone can attach a photo/screenshot to a prompt, with a thumbnail preview and a way to remove it before sending. This closes the "Image paste/attachments" row in `docs/parity.md`, which is currently deferred.

### Why backlog

Blocked on an RPC question and a UX decision, not on effort: does `pi --mode rpc` accept images on `prompt` (and on `steer` while streaming), in what shape (base64, path, MIME + data URL), and does Pi persist them in the session JSONL so a reattach/replay shows the thumbnail? Confirm against the installed Pi version before designing frames. If RPC has no image field, the ticket is "hub writes the file into the session cwd/data-dir and sends a path", which changes the scope.

### Scope

1. Composer button (`#composer`) opening a file picker; `accept="image/*"` and `capture="environment"` only if the ticket chooses camera capture. Keep the existing send button and 16 px input untouched.
2. Client preview: one or more thumbnails above/inside the composer, each removable before send; show upload/size errors inline, never in the transcript.
3. Transport: reuse the existing websocket. Decide between a `prompt` frame carrying base64 (simple, but watch `LIVE_BUFFER_BYTES`) and a separate upload endpoint that returns a handle (better for large photos). Events stay verbatim on the way back.
4. Hub: validate MIME/size, cap dimensions (e.g. downscale client-side before upload), and persist only where the ticket says (session cwd vs `<data-dir>`), with cleanup on session close.
5. Desktop: clipboard paste (Ctrl/Cmd+V) into the composer as the same path as the picker.
6. `docs/parity.md` row becomes done; `README.md` mentions attachments.

### Open questions

- Camera capture or library picker only?
- One image per prompt or multiple?
- Hard size/dimension cap, and who enforces it (client downscale vs hub reject)?
- Should an image survive `/new`, compaction and reattach, or is it send-once?
- Any command-policy interaction (`--no-images`), given the existing restrict-only policy layers?

### Done when

- A photo picked on the phone appears as a thumbnail, can be removed, and reaches Pi with the prompt (verified against a fake-pi fixture and the real child).
- Sending while busy (steer) either supports images or disables the button with a clear label; no silent drop.
- Oversized/unsupported files show an inline error and never reach the model.
- A reattach/reload shows the transcript entry as Pi recorded it (image entry or text fallback) without duplicate uploads.
- `npm run check` green, `tools/shot.mjs` at 390/1280 with a preview visible, `docs/parity.md` + `README.md` updated.

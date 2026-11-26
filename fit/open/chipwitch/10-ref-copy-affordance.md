---
grilled: false
project: pixip
series: chipwitch
---

Give every history message and every inbox message an action that puts its ref tag on the clipboard, so a pointer can be pasted into any session or any other agent.

### Scope

- History blocks: already-painted blocks carry `data-entry` (`tagEntry()` in `src/client/transcript.js`); live blocks derive the `msg:` key at paint time, so the action works without waiting for a reload.
- Inbox cards already carry `data-id` (`src/client/inbox.js`), so the same action covers `[ref=inbox/…]`.
- Clipboard goes through `src/client/clipboard.js`, which already falls back to a sheet on non-secure contexts (LAN http on a phone has no `navigator.clipboard`).

### Decisions

- Default payload is the bare tag — roughly ten tokens, no excerpt, no path.
- A second action copies the tag **plus** the quoted text, as the escape hatch for pasting into an agent without `pixip` or `PIXIP_DATA_DIR`.
- Copying an inbox message does not mark it read.
- The history action sits where `fork` already sits on a user block (`data-fork`, `src/client/render.js`), so there is one menu per message, not two affordances.

### Acceptance

- Every visible history block exposes copy; a live block works immediately after the message ends.
- An inbox card exposes copy, including when the archive toggle is on.
- Clipboard denial falls back to a sheet with the text selected, and a toast confirms the copy.
- `npm run check` green, plus `tools/shot.mjs` at 390 and 1280.

### Open

- Whether the excerpt variant caps at one line, 200 chars, or the full entry text.

### Boundaries

- Clipboard goes only through `src/client/clipboard.js`. Do not add a second clipboard path and do not touch the `/copy` builtin.
- The copy entry joins the existing per-message menu; do not reorder, restyle or replace the `fork` action on a user block.
- Inbox reads stay on the existing REST routes. No hub-side read API, no change to `src/inbox.ts`, `src/hubInbox.ts` or the `inbox` frame.
- Same hot-reload fence as `00-ref-grammar`: `src/daemon.ts`, `src/hub*.ts`, `src/wire.ts`, the `run`/`daemon` verbs in `bin/pixip.ts`, `fit/*/hotreload/`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `npm run check` green.
- Manual with the worktree daemon isolated: copy from a live block, then from the same block after a reload (the `data-entry` path), then from an inbox card and from an archived one.
- Verify the sheet fallback for a denied clipboard by loading the UI over a non-loopback http bind, where `navigator.clipboard` is unavailable — localhost alone does not exercise it.
- Paste the copied tag into `node bin/pixip.ts ref` once ticket 40 exists, or resolve it by hand from `sessions.json`.
- `node tools/shot.mjs` at 390 and 1280.
- If a browser flow is added to `tools/browser-check.mjs`, keep both sides when merging against `pixip/hot-reload`.

### Browser verification (required)

- `tools/shot.mjs` is a layout probe, not evidence. Do not close this ticket on screenshots alone.
- Run this worktree's daemon (`node bin/pixip.ts --data-dir ./tmp/refs --port 8138`) and drive `http://127.0.0.1:8138/` with the **agent-browser** tool (`open`, `snapshot -i`, `click`, `get text`, `screenshot`) for: copy from a live block, copy after a reload, copy from an inbox card, copy from an archived card.
- Scripted regression coverage goes into `tools/browser-check.mjs` (fixture Hub, ephemeral port):

  ```bash
  PIXIP_CHROME=$(ls -d ~/.agent-browser/browsers/chrome-*/chrome | tail -1) npm run check:browser
  ```

- `npm run check` silently skips `check:browser` when `PIXIP_CHROME` is unset, so a green `check` is not browser evidence. Say explicitly which of the two you ran.
- The denied-clipboard sheet fallback cannot be reached on loopback; cover it by loading the UI over a non-loopback `--host`/http bind, or assert it in the scripted check with clipboard permission denied.

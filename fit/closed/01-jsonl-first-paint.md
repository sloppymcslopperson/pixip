---
grilled: true
commit: faf665f9e94adedbb1563115f963c50a592cc435
---

### Verification

- **Socket row**: attach → provisional snapshot frame on a synthetic 17 MB session (1,900 entries, 400 KB tool outputs): 110 / 140 / 251 ms (cold daemon, cold child). 105 entries in the 256 KB tail, `more: true`, `state: "starting"`.
- **Paint row**: tap a stopped session from the loaded list (puppeteer-core, 390 px): first block 115–153 ms, painted 143–185 ms across three cold runs. `starting pi…` hint visible, no console errors, `overflowX: false`.
- **"load earlier"**: 54–77 ms for the preceding 200 entries, served from the JSONL while the child keeps running; button stays until `more: false`; windows kept across the authoritative snapshot (dedupe by entry id); scroll held via `scrollHeight - scrollTop` so prepends do not move the view (verified: 40,656 px before → 42,275 px after, same content).
- **Full cold page load** (browser navigation, empty session) → painted: ~230 ms; with a 200-entry window: ~430–550 ms. That row is the browser's own asset load (170–240 ms before any socket), recorded separately in ARCHITECTURE.md; the budget row is the tap-to-paint one.
- `npm run check` green: typecheck + 43 tests (`test/window.test.ts` covers partial first line, truncated final line, corrupt records, header filtering, 200/800-entry windows, full-window growth behind a 400 KB entry, unknown anchor).
- `tools/shot.mjs` at 390 and 1280 on the markdown session (no regression) and on a 600-entry session (load earlier visible): no console errors, no horizontal overflow.

### Implementation notes

- `hub.provisional()` reads the JSONL tail before spawning; `readFromEnd` + `parseEntries` never throw, drop the partial first line when the read starts mid-file, skip unparsable records and filter the `session` header.
- `hub.snapshot()` windows `get_entries` to the newest 200 and reports `more`; `hub.earlier()` reads backwards in growing bounded budgets (256 KB → 1 MB → 4 MB cap) until a full 200-entry window fits behind the anchor.
- `header()` now reads a bounded 8 KB head instead of the whole file, so listing a 17 MB session no longer reads 17 MB.
- Client: `snapshot.more` drives the button; `history` prepends; first paint lays out only the newest ~24 KB and fills the rest in 32 KB chunks, one `innerHTML` per chunk.
- `earlier` commands are accepted while the child boots (message handler bound before the attach await).
- `ARCHITECTURE.md`: provisional flow, `more`/`history`/`earlier` frames, `starting` state, measured rows and the startup note updated.

commit: faf665f

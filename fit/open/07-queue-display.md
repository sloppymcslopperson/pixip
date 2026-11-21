---
grilled: true
leg: tui-parity-1
---

Send-while-busy is silent today: the composer queues a steer but the transcript shows nothing. Mirror the TUI's pending queue as chips above the composer, fed by the `queue_update` event, with a clear action that restores the queued text.

### Why now

Slice 5 of the TUI-parity leg: dogfooding pixip means steering a running agent often, and losing track of what was queued leads to duplicate prompts.

### Done when

- `queue_update` (`steering`, `followUp` arrays) renders one chip per queued message above the composer with the queued text and a count; they clear when the queue empties.
- An X on the chips sends a `clear_queue` frame; the hub returns `{steering, followUp}` texts and the client restores them into the composer (TUI Esc behaviour) with a toast.
- Plain text while busy keeps sending `steer`; the chips are read-only besides the clear action.
- `npm run check` green; `docs/parity.md` marks the queue done; owner runs the 390/1280 screenshots.

### Decisions (grilled 2026-11-21)

- Use the existing verbatim `queue_update` event; no new event shape and no polling.
- One `clear_queue` call clears both steering and follow-up (RPC semantics); no per-item removal.
- Restored text is joined with newlines in the composer, focused and resized; it is not sent automatically.
- The chips live between the transcript and the composer, above the (moved) footer, and truncate long lines with an expand on tap.

### Files

`src/client/app.js`, `src/client/index.html`, `src/client/style.css`, `src/server.ts` (`clear_queue` frame), `src/hub.ts`, `src/wire.ts`, `test/fixtures/fake-pi.mjs` (emit `queue_update`), `test/`.

### Tests

- Fake Pi: emit `queue_update` with steering/follow-up texts; `clear_queue` returns them.
- Pure: chip text/truncation helper if extracted.
- Integration: a busy session queues a steer, receives the queue frame, clears it, and gets the texts back.

### Notes

- `queue_update` carries the complete current queue on every change; replace state rather than appending.
- Do not add follow-up sending in this slice (plain text keeps steering while busy).

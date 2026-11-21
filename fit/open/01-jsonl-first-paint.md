---
grilled: true
---

Opening a stopped session costs ~1.3 s because a fresh `pi --mode rpc` child must boot before `get_state` answers.

### Goal

First paint under 300 ms on a cold attach, without adding a warm-child pool (this box is 1 vCPU / 2 GB).

### Approach (decided)

Paint from the session JSONL first, then reconcile:

1. On open, read the JSONL for that session and send a snapshot built from its entries immediately, with the session marked `state: "starting"`.
2. Spawn the child as today; when `get_state`/`get_entries` answer, send the authoritative snapshot and continue with live events.
3. Ignore the duplicate paint cost: replacing the log once is cheaper than a 1.3 s blank screen.

### Done when

- `state: "starting"` is shown while the child boots, and the transcript is visible before it answers.
- Entries parse from disk without a live child (skip unparsable lines; never throw on a truncated tail).
- The client replaces the provisional transcript with the live snapshot without losing scroll position when the user is pinned to the bottom.
- Measured: cold attach to first paint under 300 ms on this box, recorded in ARCHITECTURE.md next to the existing numbers.

### Files

`src/hub.ts` (JSONL snapshot path), `src/server.ts` (open flow), `src/client/app.js` (starting state + snapshot replace), `ARCHITECTURE.md`.

### Notes

- Reuse the existing header reader logic in `hub.ts` rather than adding a second JSONL parser.
- Do not subscribe before the child is up; the gap is covered by the authoritative snapshot.

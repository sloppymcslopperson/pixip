Opening a stopped session costs ~1.3 s because a fresh `pi --mode rpc` child must boot before `get_state` answers.

### Goal

First paint under 300 ms on a cold attach, without adding a warm-child pool (this box is 1 vCPU / 2 GB).

### Decisions (owner, 2026-11-21)

- The provisional first paint shows the **last ~200 entries**, not the whole file, with a "load earlier" affordance for the rest. A 17 MB session must not blow the budget.
- No warm pool; read the JSONL while the child boots.

### Approach

1. On open, read the session JSONL, parse the tail (~200 entries), and send a snapshot built from it with the session marked `state: "starting"`.
2. Spawn the child as today; when `get_state`/`get_entries` answer, send the authoritative snapshot and continue with live events.
3. The client replaces the provisional transcript with the live snapshot, keeping scroll position when pinned to the bottom.

### Done when

- `state: "starting"` is visible while the child boots and the transcript is already readable.
- Tail parsing skips unparsable lines and a truncated final line; it never throws.
- "load earlier" fetches the preceding window from the hub (one additional frame type), and the client keeps it when the live snapshot arrives.
- Measured: cold attach to first paint under 300 ms on this box, recorded in ARCHITECTURE.md next to the existing numbers.

### Files

`src/hub.ts` (JSONL tail + window reader), `src/server.ts` (open flow + earlier window), `src/wire.ts` (window frame), `src/client/app.js`, `ARCHITECTURE.md`.

### Notes

- Reuse the existing header reader rather than adding a second JSONL parser.
- Do not subscribe before the child is up; the authoritative snapshot covers the gap.

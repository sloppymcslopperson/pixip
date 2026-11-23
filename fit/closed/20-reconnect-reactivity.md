---
grilled: true
---

sessions reconnect very slowly. Switching between hot sessions is a bit painful, and re-opening the app after the browser has been closed feels sluggish. Reconnect times should be brought down to as close to half a second as possible. If they get down to a quarter second I’ll give you a cookie.

### Decisions

- Scope is greens/yellows only: sessions with a live child. Grey/`stopped` sessions do not need a hot reconnect.
- No warm child pool in this ticket. A separate backlog spike covers an update-friendly Pi fork that can hot-swap records.
- Budget is tap -> first readable transcript painted, not a fully settled frame. Median of 5 on this box, 250 ms target, 500 ms acceptable. Reload counts from navigation start.
- Full text is lazy: the initial window is bounded to 256 KB total and 8 KB per text field. Expanding a truncated block fetches that whole entry from the JSONL; non-collapsible long text gets a `load full` button. A single fetched entry is capped at 8 MB.
- An entry not yet written to the JSONL (in-flight turn) is not found: keep the truncated text and toast; expanding again later works.
- Early send: for green/yellow sessions the composer must be usable as soon as the fast snapshot lands. Cold/grey sessions keep `starting` and stay disabled.
- New-session create is in scope: bench tap New -> composer ready, target 1.5 s median, measured both alone and while one other agent is busy streaming. If Pi's own boot is the floor, report it and open a separate ticket rather than adding a pre-spawned child here.
- Benchmark is a script, not a CI timing gate: `tools/reconnect-bench.mjs` with a generated 11 MB fixture.

### Measured baseline (11 MB session, this box)

| step | current |
| --- | --- |
| connect -> provisional JSONL snapshot | 65 ms (23 entries, 258 KB) |
| connect -> authoritative snapshot | 7.17 s cold / 4.6 s warm, 8.4 MB frame |
| cold Pi spawn | 1.38 s |
| reconnect with durable cursor | 45 ms, 477 bytes |
| create -> `opened`, alone | ~0.9 s |

The authoritative `get_entries` history read and the unbounded 200-entry frame are the reported sluggishness, not the spawn.

### Plan

- Serve the authoritative window from the JSONL tail with the same byte/entry caps as the provisional paint, instead of asking Pi for all history. For a live child, a bounded `get_entries since=<JSONL leaf>` catches the in-flight turn.
- Reconnect a cached in-page session with its durable cursor, skipping the provisional repaint and receiving only the delta.
- Truncate and mark resume deltas too; add an `entry` request/frame so the client can lazily fetch one full entry from the JSONL.
- Add the benchmark, unit coverage for bounded windows/cursors/lazy entries, and update `ARCHITECTURE.md` numbers and snapshot description.

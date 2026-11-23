---
project: pixip
---

Give parked green sessions a per-session client state so live events are applied while away and switching back needs no network round trip. Keep the active DOM as the only rendered transcript, and keep busy yellow sessions muted by default to protect cell data.

### Context

After `05-park-live-sockets`, a return still sends a resume delta: ~123 ms median, p95 266 ms on the owner's cell link. Applying live events into a per-session store while parked removes that last round trip for sessions that are still green.

### Scope

- Add a per-session client store keyed by id: entries, info, footer, queue, policy, commands, addon, streaming/thinking state. DOM stays active-only.
- Apply background event frames to that store with pure helpers, reusing `render.js`/`transcriptWindow.js` where possible. Do not re-implement Pi's JSONL semantics.
- On activation, bind the store to the global view and repaint; no `resume` request for a green session that has had no gap.
- Green/idle sessions apply events in the background. Busy/yellow sessions stay muted and use the ticket-05 resume path; any background-busy likely needs explicit opt-in because of cell data.
- If a gap is detected (missed socket, cursor rejected, rekey/restart), fall back to the bounded resume delta.

### Acceptance

- Switching to a green session that received events while parked paints its current transcript with zero network requests.
- No duplicate entries when a background event races a resume delta or snapshot.
- A parked busy session sends no bytes unless the user opted in.
- Long parked idle sessions stay bounded (entries capped by the same window rules).
- Tests: pure store/reducer, activation binding, race with snapshot/delta, browser check.
- Document the data/one-RTT tradeoff in `ARCHITECTURE.md`.

### Dependencies

Requires `05-park-live-sockets`. Revisit whether a multiplexed single socket is cheaper once multiple parked sockets exist.

### Edge cases

- `/new` rekey or daemon restart while parked: invalidate the store and reconnect normally.
- Pending UI and queued steering: keep the control-frame cache current; replay UI on activation.
- Switching to a session that is already busy and streaming: prefer the resume delta unless background-busy is enabled.

### Out of scope

- Rewriting the hub or Pi event path.
- Rendering more than one session DOM at a time.
- A multiplexed socket unless the parked-pool work proves it necessary.

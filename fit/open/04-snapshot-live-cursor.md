---
grilled: true
---

Entries that arrive between `get_entries` and the subscription are lost, so a client connecting mid-turn can miss the start of a message.

### Goal

No lost or duplicated entries across the snapshot/live boundary, using Pi's durable entry cursor.

### Done when

- The socket subscribes before requesting the snapshot and buffers live frames meanwhile.
- After the snapshot, buffered frames are flushed; anything already covered by the snapshot is dropped by comparing against `leafId` (and message identity where needed).
- On reconnect, an existing transcript can resume with `get_entries` and `since: <leafId>` instead of a full re-send (server side), proven by a test with a fake RPC peer.
- `npm run check` passes; no change to the wire version unless the frame shape actually changes.

### Files

`src/server.ts` (subscribe/snapshot order), `src/hub.ts` (`get_entries` with `since`), `src/client/app.js` (reconcile path), `test/`.

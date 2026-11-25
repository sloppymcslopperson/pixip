---
grilled: false
project: pixip
---

A running compaction cannot be cancelled from pixip, because no client control sends the existing `abort` frame. Add a cancel control to the compaction status block.

### Decisions

- Cancelling a manual idle compaction stops it and returns the user to the unchanged transcript, as though `/compact` was never called.
- Cancelling a threshold/overflow compaction also aborts the running turn (Pi has no compaction-only RPC verb); the control must say so explicitly.
- Keep the header Stop semantics unchanged; cancellation belongs on the compaction status block.

### Acceptance

- Manual compaction offers `cancel`; abort removes the status block, keeps history unchanged and restores the composer.
- Auto-compaction offers `cancel compaction and stop turn`; the label makes the turn abort explicit.
- Cancelled compaction never writes a boundary and never leaves a resnapshot pending.
- `npm run check` green plus 390/1280 screenshots.

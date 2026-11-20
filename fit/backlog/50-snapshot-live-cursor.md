Snapshot and live events have a small race: entries arriving between `get_entries` and the subscription are lost.

### Notes

- Subscribe first, buffer, then snapshot, then flush buffered events past `leafId`.
- Or use `get_entries?since=<leafId>` on reconnect to close the gap with a durable cursor.

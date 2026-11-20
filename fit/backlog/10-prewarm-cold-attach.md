Opening a stopped session costs ~1.3 s because a fresh `pi --mode rpc` child has to boot before `get_state` answers.

### Goal

Make the first paint immediate: render the transcript from Pi's JSONL while the child starts, or keep one pre-warmed child per active cwd.

### Notes

- Snapshot today comes from `get_entries`, which needs a live child; parsing the JSONL header plus message entries is enough for a read-only first paint.
- A warm pool costs RAM on a 1 vCPU / 2 GB box, so if used it needs the same idle policy as `--idle-ms`.
- Budget: first paint under 300 ms on a cold attach; measured baseline is in ARCHITECTURE.md.

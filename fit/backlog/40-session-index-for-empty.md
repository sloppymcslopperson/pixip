Pi writes the session JSONL on the first message, so a session created and detached without a prompt disappears from the list.

### Notes

- Keep a tiny per-data-dir index (id, cwd, name, created_at) written at spawn time.
- Must not become a second source of truth: JSONL still wins when it exists.

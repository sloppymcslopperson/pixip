Stopped sessions show their id prefix because the disk scan only reads the JSONL header, while the display name lives in `session_info` entries.

### Notes

- Either read forward until the first `session_info` entry (cheap, bounded) or keep a small sidecar index in `--data-dir`.
- `session_info_changed` already updates live sessions; only the stopped path is missing.

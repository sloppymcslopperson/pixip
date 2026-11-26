---
project: pixip
---

Optional developer convenience: watch `src/` and `extensions/` and trigger the same reload path after a debounce, off by default. An explicit `/reload` stays the default trigger because a watcher can fire on a half-written file.

### Scope

- `--watch` flag on `run`, `fs.watch` with debounce and a single in-flight guard.
- Reuse the reload gate: if any session is busy, defer until idle instead of interrupting.
- Log what was reloaded, and surface a toast/notice on failure without killing the daemon.

### Acceptance

- Edit a client asset and an extension; both appear without a manual command.
- A busy session defers rather than interrupts.
- A syntax error during a write does not leave the daemon broken.
- No watcher noise in the test suite.

### Depends

- `05-reload-command`

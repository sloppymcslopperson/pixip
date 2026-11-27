---
project: pixip
grilled: true
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

### Grilled decisions

- Flag: `--watch` on `run` and on a detached `daemon` start. Off by default; no env/config layer.
- Roots: `src/` (including client assets) and `extensions/`, resolved from the package root derived from `bin/pixip.ts`. Ignore `node_modules`, `.git`, the data dir/sessions, and `fit/`.
- Debounce: 200 ms; coalesce changes that arrive during a reload into one pending rerun; at most one reload in flight.
- Busy deferral: retry the reload gate about once a second. After 60 s still blocked, paint an ephemeral card with `Keep waiting` and `I'll reissue later`. While the card is up, keep polling and auto-remove it if the reload succeeds. `Keep waiting` dismisses it and polling continues; the card re-appears after another 60 s still busy. `I'll reissue later` cancels the pending reload. Log the deferral once.
- Failure: a failed reload (including a half-written file) keeps the daemon alive, logs the error and broadcasts an ephemeral notice/toast; the next file change retries.
- Implementation/tests: new `src/reload/watch.ts` with injectable `fs.watch` and reload callback; one targeted unit test using temp dirs. Existing tests stay quiet because the watcher is off by default.

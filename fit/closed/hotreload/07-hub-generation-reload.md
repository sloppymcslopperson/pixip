---
project: pixip
grilled: true
---

Extend `/reload` to swap the daemon's own TypeScript in place: a resolve hook that versions `src/` imports per generation, a hub prototype swap, and a swappable server handler, keeping live children and sockets untouched. Mechanics were verified on this Node (22.23.5): query-string re-import creates a fresh instance and a `module.register` hook can propagate the generation from `context.parentURL` to the whole graph.

### Design

- `src/reload/register.ts`: resolve hook appends `?gen=<N>` to project `src/` specifiers, inheriting N from `context.parentURL`.
- `src/reload/manager.ts`: generation counter, `reload()`, rollback, report.
- `src/server.ts`: `state.impl = {handleHttp, handleSocket, refresh}` read at call time so an open listener runs new code.
- `src/hub.ts`: methods stay `this`-state-only; reload does `Object.setPrototypeOf(existingHub, NewHub.prototype)`.
- `bin/pixip.ts`: `serve()` dynamic-imports `../src/hub.ts` and `../src/server.ts`.
- Move `src/pendingReask.ts` `writes` map onto the hub instance (the only module-level mutable state today).

### Constraints

- No module-level mutable state or timers in reloadable modules; add a test or lint rule.
- A failed import keeps the old generation serving; never half-swap.
- Flag and `HubOptions` changes report `requiresRestart` rather than pretending.
- Existing sockets keep old once-per-connection wiring: document that new wiring needs a reconnect while changed hub methods apply immediately.

### Acceptance

- Edit `hubControl.ts`, `/reload`, next request runs new code; an already-open socket sees the new hub behaviour.
- Edit `server.ts`, `/reload`, an already-open listener serves the new behaviour.
- Broken edit → 500 report, old generation intact.
- Retained old generations documented and bounded by socket lifetime.

### Depends

- `05-reload-command`

### Decisions (grilled)

- Tests: fixture modules. Unit-test the resolve hook and manager against temporary fixture modules; integration-test the swap against a fixture implementation. Do not edit the repository `src/` from tests.
- Retention: GC by references. The manager keeps only the current generation plus report metadata; retired generations stay alive only while old sockets/handlers reference them and are then collected. Document this in the report and architecture.
- `requiresRestart`: entry + flags only. Any `src/**` change is reloadable; changes to `bin/pixip.ts`, serve flags, `HubOptions`, or environment report `requiresRestart`.
- Transaction order (recommended, owner may issue a correction ticket): import the new generation first and fail closed. An import error aborts with the old generation and changes nothing else. On success, swap the hub prototype and the server handler implementation, commit assets/nonce and hub policy, then reload children. Per-child failures are `partial` and the new code stays.
- “500 report” means the existing reload error report (`ReloadReport` with `status: "error"` through the WS notice and `<data-dir>/pixip.reload.json`), not a new HTTP endpoint.
- Rollback: before the commit point keep the old generation serving; after the commit point do not roll code back for per-child failures.

\n### Implementation notes\n\n- `GenerationManager` keeps the successful generation and a separate attempt counter. A failed import burns its attempt number because Node caches a rejected dynamic import by URL; retrying the same `?gen=N` after fixing the edit would reuse the error. The next retry imports a fresh URL.\n- `src/server.ts` exposes `createImpl(hub, state, options, broadcast)`; the live listener calls `state.impl.handleHttp` / `state.impl.handleSocket` / `state.impl.refresh` / `state.impl.reload` at call time. `RunningServer.applyGeneration` swaps the hub prototype and installs the new impl; `rollbackGeneration` installs the previous one.\n- `bin/pixip.ts` registers `src/reload/register.ts` before dynamic-importing generation 0 of `hub.ts` and `server.ts`. `requiresRestart` compares the entry mtime and the serve-flag snapshot.\n- `src/pendingReask.ts` no longer owns a module-level `writes` map: the map lives on the hub instance and the file helpers take it as an argument.\n- Tests: `test/reload-generation.test.ts` covers the manager and resolve hook; `test/reload.test.ts` covers fail-closed import errors and the server swap seam; `test/daemon.test.ts` reloads a real daemon into generation 1 and 2 without replacing the pid.\n- Manual verification: editing `src/server.ts` then `pixip reload` changed `/api/info` on the already-open listener (gen 1); appending a syntax error produced `reload failed before any change` while the old generation kept serving; restoring the file reloaded into gen 3 after the failed attempt.\n- `npm run check` is green. Browser screenshots were unavailable because `PIXIP_CHROME` is unset.\n

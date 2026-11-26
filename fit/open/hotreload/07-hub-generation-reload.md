---
project: pixip
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

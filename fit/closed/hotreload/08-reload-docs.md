---
project: pixip
grilled: true
---

Document the reload/restart contract and the backend default in `ARCHITECTURE.md`, which is the source of truth for the lifecycle and the latency budget.

### Content

- New "Reload and restart" section: gate (non-idle, pending UI, bash), daemon-wide scope, transaction/rollback, ephemeral notices, `--use-system-pi` vs the default host, and the `setPrototypeOf` mechanism.
- State explicitly that agent-trigger prevention is affordance-only, not an auth boundary, consistent with the unauthenticated UI posture.
- Fold the two-backend comparison table to the default host path and note the `--use-system-pi` column.
- Update open design question 2 (hub restart kills live children) to reference reload/respawn.
- Record reload round-trip and hub swap times in the latency table if they move numbers.

### Acceptance

- Numbers match what the tickets measure; no stale claims about a silent legacy fallback.
- Rust-port boundary section still true (reload is a Node affordance; the port may implement it as a supervised restart).

### Decisions (grilled)

- Extend the existing lifecycle prose into one "Reload and restart" section rather than adding a second, overlapping section.
- Add a small repeatable bench for `/reload` round-trip and hub generation swap; record the numbers only if they move the latency table.
- Resolve open design question 2: remove the "resume-all-on-start?" question and state the contract. In-place `/reload` keeps children and sockets, so hot/warm grouping is unchanged. `/pixup-restart` preserves the visible hot set: the new daemon reattaches the sessions that were live before the restart, so the dashboard does not visibly lose hot sessions.
- Document that the user-only gate is an affordance, not an auth boundary, consistent with the unauthenticated UI posture.
- Fold the two-backend comparison table to the default host path and keep the `--use-system-pi` column.
- State that reload is a Node affordance; a Rust port may implement it as a supervised restart.
- Cover the gate (non-idle, pending UI, bash), daemon-wide scope, transaction/rollback, ephemeral notices, `--use-system-pi` vs the default host, and the `setPrototypeOf` mechanism.

\n### Implementation notes\n\n- `ARCHITECTURE.md` now has one `## Reload and restart` section covering soft refresh, `/reload` (gate, import-first fail-closed transaction, `setPrototypeOf`, `state.impl`, generation retention/GC, reports, `requiresRestart`), `/pixup-restart` (browser-only user gate, inline force card, detached helper, hot-set reattach, pid/uptime notice), the affordance-not-auth statement, the default host vs `--use-system-pi` behavior, and the Rust port note.\n- The backend comparison table now lists `pixip-pi-host` first and labels the legacy column `--use-system-pi`.\n- Open design question 2 is resolved in place: no resume-all-on-start; reload keeps children/sockets and restart reattaches the persisted live set.\n- Added `tools/reload-bench.mjs`. Measured on this box, idle daemon, 5 runs: soft refresh 15.8 ms median / 20.1 ms p95; full `/reload` with a fresh code generation 152 ms median / 152.6 ms p95; rough import/swap cost ~136 ms. These rows are in the latency table with the bench caveat.\n- `npm run check` green. Browser screenshots were unavailable because `PIXIP_CHROME` is unset; the scripted browser check skipped.\n

\n### Browser check (correction)\n\nCompleted with the available `agent-browser` tool at 390×844 and 1280×900. The earlier note about `PIXIP_CHROME` being unset only applies to the repo's puppeteer `tools/shot.mjs`/`check:browser` path; browser verification itself used `agent-browser`.\n

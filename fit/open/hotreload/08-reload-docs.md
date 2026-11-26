---
project: pixip
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

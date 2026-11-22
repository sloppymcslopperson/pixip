---
grilled: true
commit: "629929142e56685666f3580ec6edef57ef4040b4"
---

when the agent begins thining, a little "agent is thinking..." message should appear that is replaced with the actual thinking box when done

### Decisions

- Placement: a muted meta block at the bottom of the transcript, like the existing `starting pi…` / wake blocks.
- Copy: `agent is thinking…` with a subtle pulse animation.
- Lifecycle: show at `agent_start`; remove when the first assistant `message_end` renders a thinking box; also remove on `agent_settled` or error if nothing arrived.
- Multi-step turns: show again after each tool result until assistant text/thinking arrives, not only once per turn.
- The placeholder is transient UI only; it must not be persisted or confused with a real thinking entry.

### Acceptance

- Starting a turn shows the indicator immediately.
- Completing the turn replaces it with the real `details.think` box (or removes it if there was no thinking).
- `npm run check` green and `tools/shot.mjs` at 390 and 1280.

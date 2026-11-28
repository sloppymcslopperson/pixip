---
grilled: true
---

Add `agent_send` and `pixip agents send` so an agent can message another session exactly like a human would. The sender gets an immediate acknowledgement with a delivery state and the target URL, and never waits for the target's turn.

### Goal

- Add a hub send operation exposed as `POST /api/agents/:id/messages`. Resolve the target by exact id or logical id first, then by unique name or id prefix; ambiguous or unknown targets fail with a readable list of candidates.
- Wake anything addressable: attach a stopped target, and restore an archived/trash target to the active board before attaching it. A message by explicit id is the only way to reach an archived target.
- Deliver as a normal prompt. Prefix the text with `[pixip-agent=<senderId>]` followed by a newline, where `senderId` is `PIXIP_SESSION_ID` when the caller is inside a session and `local-shell` otherwise.
- Use a normal prompt for an idle target and `prompt` + `streamingBehavior: "steer"` for a busy target. Do not use RPC `steer`, do not queue with `followUp`, and do not wait for the target turn to finish.
- Return an acknowledgement such as `{ deliveryId, target: { id, name, url, stateBefore, stateAfter }, delivered, woken, streaming, at }`. Write a bounded delivery log under `<data-dir>/` so `GET /api/agents` can expose each target's `lastDelivery`; no automatic receipt message is sent.
- Add an `agent_send` tool to `extensions/pixip-agents` and `pixip agents send <target> <message> [--json]`. The tool result must include the target URL so the caller can open the page.
- The target can reply by calling `agent_send` back. A sender that wants confirmation checks `agent_list`'s `lastDelivery` or sends another message.

### Done when

- Sending to an idle, busy, stopped, archived, and trash target is covered by tests, including the marker text and the steer behavior for busy targets.
- Ambiguous names/prefixes are refused; exact ids always win.
- The delivery log is bounded, survives a daemon restart, and is exposed through `lastDelivery` without changing the discovery contract.
- CLI and extension tests use a fake daemon and cover the acknowledgement, URL, and error strings.
- `npm run check` is green, including the workspace check for the extension.

### Decisions

- Same semantics as a human message, including waking stopped/archived targets.
- Immediate ack plus status lookup; no automatic reply message.
- The marker is plain prompt text so it persists in Pi's JSONL; ticket 30 owns the styled rendering.
- Creating sessions remains a web-UI feature.

### Out of scope

- Client bubble rendering (ticket 30) and any web authentication or restricted-mode gate.

### Grilling answers

- Sender: request body field `sender`; CLI/extension pass their own `PIXIP_SESSION_ID`, fallback `local-shell`. Trim; empty means `local-shell`; reject control/newline characters and values over 128 characters with 400.
- Resolution: exact id/logical id across active and stored first, then unique active name (case-insensitive), then unique active id/logical-id prefix. Archived/trash only by explicit exact id/logical id, never name or prefix. Exact ids always win.
- Delivery log: full acknowledgement per target, newest 200, persisted as `<data-dir>/agent-deliveries.json`. `lastDelivery` is exposed on active rows only, keyed by logical id.
- Errors: unknown 404, ambiguous 409 with candidates, empty target/message or bad sender 400, attach/restore/prompt failure 502.
- `starting` targets get a normal prompt; only `busy` gets `streamingBehavior: "steer"`.
- Sending to the sender's own session is refused with 400.

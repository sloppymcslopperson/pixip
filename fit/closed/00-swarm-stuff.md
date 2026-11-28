---
grilled: true
---

Agents need a first-class way to discover other pixip sessions and message them without opening the web UI. Split into three child tickets under `open/agent-comms`: discovery, messaging transport, and client bubble rendering. Restricted-mode browser access is handled by a separate ticket on the pi-slop board.

### Decisions

- This ticket creates the child tickets only; implementation happens there.
- Interface is both: a `pixip-agents` Pi extension (tools, opt-in like `pixip-inbox`) and `pixip agents` CLI commands.
- Discovery covers all active board sessions (live, attached, stopped); archived is opt-in. Every returned agent carries a `#s=<id>` URL, and the calling session is marked.
- Messaging behaves like a human message: it wakes stopped or archived/trash targets and delivers a normal prompt. A busy target gets `streamingBehavior: "steer"`.
- `agent_send` returns immediately with an acknowledgement and delivery state; it never waits for the target's turn.
- No automatic receipt message. `agent_list` exposes the last delivery state, and the target can reply with `agent_send`.
- Inbound messages use the prompt prefix `[pixip-agent=<senderId>]`; the client renders a styled bubble and hides the marker.
- Restricted-mode UI access is enforced outside this board: pi-slop ticket `open/00-block-browser-in-plan-mode.md` blocks the `browser` tool while FIT planner mode is on. Pixip adds no web auth for this.

### Child tickets

- `open/agent-comms/10-agent-discovery.md` — `agent_list` + `pixip agents list` + `GET /api/agents`.
- `open/agent-comms/20-agent-message-send.md` — `agent_send` + `pixip agents send`, wake/attach, ack, delivery log.
- `open/agent-comms/30-agent-message-bubble.md` — client parses the prefix, renders the sender bubble and link. Depends on 20.

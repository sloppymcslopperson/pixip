---
area: host-protocol
part: inventory
project: feature-inventory
---

Capture the protocol and host boundary that make the product possible: the embedded Pi host, the RPC framing, the panel extension, and the browser-hub wire contract. This is the area a rewrite is most likely to redesign, so it is described as a contract, not as code structure.

### Goal
An inventory reader should understand what crosses each boundary and which guarantees the UI depends on, so a rewrite can replace the transport without losing behaviour.

### Scope
- System shape: browser <-> hub <-> Pi child, one child per attached session, raw event passthrough.
- `pixip-pi-host`: spawn arguments, `hello`, `panel`, shared Pi state, boundary, and the default-backend decision.
- RPC v1 framing: LF-delimited JSON, response correlation, error/timeout handling, and why events are forwarded verbatim.
- Wire protocol v1 hub->client and client->hub frames, version bump policy, and which frames are streaming vs request/response.
- Bounded snapshot/window, resume cursor, policy/addon/pending-UI replay on reattach, and re-key on `/new`, fork, clone, import.
- REST's narrow role: discovery, process verbs and downloads, never streaming.
- The port map and latency budgets as constraints the new design must meet or consciously change.

### User stories to cover
- As a user, I want opening a session to paint readable history immediately and then catch up without missing entries.
- As an extension author, I want my unchanged Pi extension to keep working through the hub.
- As a user, I want a pending question to survive a reconnect and still be answerable.
- As a rewrite engineer, I want a precise list of frames and guarantees so I can redesign the transport deliberately.

### Wireframes (SVG, no screenshots)
- Series of diagrams: system context (browser/hub/Pi/extensions), sequence for open-session and prompt, sequence for extension panel and replay.
- Decision-flow diagram: event path (raw passthrough vs parsed), reattach with/without cursor, backend selection.

### Technical notes (port-relevant only)
- This whole section is the technical contract; keep it in a clearly marked "protocol" part and keep user stories separate.
- State ownership: hub holds process state, JSONL is the source of truth, client holds windows.
- What must be preserved (verbatim events, one scroll container, no re-encode) vs what may be replaced (Node reload machinery).

### Sources to read
`pi-host/*`, `src/rpc.ts`, `src/wire.ts`, `src/server.ts`, `src/hub*.ts`, `src/liveThinking.ts`, `ARCHITECTURE.md` (invariants, data flow, wire protocol, Rust port map), `pi-host/README.md`.

### Acceptance
- Every frame and REST route is listed with its purpose and direction.
- Open-session, prompt, reattach, panel/replay and re-key flows each have a sequence.
- Guarantees and explicitly replaceable parts are separated.
- SVG diagrams show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric framing first, then the protocol contract in its own part. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/90-host-protocol.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG diagrams, and the protocol contract in a separate part.

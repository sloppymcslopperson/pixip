Render inbound inter-agent messages as a distinct bubble in the target transcript. Parse the `[pixip-agent=<senderId>]` prefix written by `agent_send`, hide the marker from the body, show who sent it, and link to the sender's session page.

### Goal

- Add one client module (for example `src/client/agentMessage.js`) that owns the marker grammar and exposes a pure parser returning `{ senderId, body }` or `null`.
- Recognise only a marker on the first line matching `[pixip-agent=<id>]` followed by a newline or the end of the text. Ids use the same safe charset as reftags. Malformed or absent markers keep the ordinary user bubble.
- Render the block as a distinct agent-message bubble: a header like `Agent <name> sent a message` (falling back to the id) and the body without the marker. Resolve the sender name and route id from `state.sessions` by logical id or current Pi id.
- Make the sender a button that opens `#s=<routeId>` when the sender is still addressable. If it is gone, show plain text rather than a dead link.
- Keep the normal user-message body rendering, linkification, and escaping for the message body. Do not alter the hub, the JSONL, or the prompt text.
- Work after reload because the marker is stored in the user message.
- This ticket also covers the bubble's sender link and its URL presentation. General tool-result URLs stay plain text.

### Done when

- Parser tests cover valid markers, missing newline, empty body, malformed markers, unusual but valid ids, and ordinary messages.
- Render tests cover name resolution, fallback id, addressable sender link, and missing sender.
- A real browser pass at 390 px and 1280 px shows the bubble, the sender link, no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`), and normal behaviour after reload.
- `npm run check` is green.

### Dependencies

- Depends on ticket 20 for the `[pixip-agent=<senderId>]` prefix. Until 20 lands, no live producer exists; tests can use fixture prompt text.

### Out of scope

- Changing the marker format or delivery semantics, automatic receipts, and any hub/CLI work.

On desktop Firefox the dashboard loads, but opening any existing or new session stays on the "connecting…" header and never paints a transcript. The owner is pausing this until it can be reproduced in a proper debugging setup; the local headless-Firefox check against the live daemon did connect and receive a snapshot, so the environment/variant matters.

### Symptom

- Dashboard (`GET /`, `/api/info`, `/api/sessions`) renders normally.
- Clicking a session or creating one navigates to `#s=<id>` but the title remains `connecting…`.
- Neither existing sessions nor a new session become usable.
- Suspected focus: the session WebSocket (`/ws?session=<id>`) never upgrades or its frames never reach the client. The dashboard can look healthy over REST even when WebSockets are broken, because `showList()` also fetches `/api/info` and `/api/sessions`.

### What was checked

- `node bin/pixip.ts` daemon on `100.42.42.1:8137` answered `/health` and `/api/sessions`.
- A direct Node `ws` client opened `/ws?session=<id>` and received `policy`, `snapshot`, `footer`, etc.
- Playwright Firefox 132 headless (Ubuntu 22.04, downloaded deps) loaded the dashboard and opened a live session, receiving the `hello` and session `snapshot` frames. No local Firefox failure reproduced.
- The client has no `ws.onerror`; a failed upgrade may only surface through `onclose`/backoff, so capture browser DevTools Network → WS status and console errors on the failing desktop.

### Next steps

- Reproduce on the actual desktop Firefox, including private window/clean profile, and record: URL host/protocol, exact Network WS status (101 vs failed), console/page errors, and whether `wss:` is expected (HTTPS page or proxy/TLS terminator).
- Check proxy, VPN, extension, and Firefox `network.websocket.*` / HTTP proxy settings for that profile.
- If it reproduces, add `ws.onerror` diagnostics and a visible connection-failure state instead of leaving the header on `connecting…`.
- Verify both an existing session and the `#new` create path on the same browser.

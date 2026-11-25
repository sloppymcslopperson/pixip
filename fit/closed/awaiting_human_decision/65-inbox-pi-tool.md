---
grilled: true
project: pixip
commit: "03e00a073352320e041c96b5fcb778c260d0ab7f"
---

Ship an opt-in Pi extension that registers an `inbox_send` tool, so agents can message the inbox without shell quoting. It is a thin wrapper over the hub endpoint and must not change any existing extension behaviour.

### Settled decisions

- A workspace extension under `extensions/` (same shape as `extensions/pixip-questionnaire`) registers `inbox_send(subject, body, purpose)` with the four purpose values from `open/63-inbox-hub.md`.
- The tool posts to `PIXIP_DAEMON_URL` and sends `Authorization: Bearer $PIXIP_INBOX_TOKEN` only when that env var is set. No address guessing and no direct file writes.
- Opt-in loading (project extension set or `-e` path); no change to the default Pi launch until `backlog/90-pi-plugin-isolation.md` settles the extension-set story.
- Failure surfaces as a tool error string that tells the agent what to do (daemon down, wrong token), never a crash.

### Acceptance

- With the extension loaded, an agent can call `inbox_send` and the message appears in the inbox with the correct sender and purpose.
- Without `PIXIP_DAEMON_URL`, the tool returns a clear configuration error.
- Existing extensions and the hub's plugin-transparency invariant are untouched.
- Workspace `npm run check` green, including the extension's own check script.

### Grilling

Further grilling is welcome for the tool description/system-prompt wording and whether the tool also offers a `list` action later. The decisions above are settled.

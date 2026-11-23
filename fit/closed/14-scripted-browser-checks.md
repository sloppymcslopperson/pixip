---
project: pixip
grilled: true
---

### Implementation notes

- `tools/browser-check.mjs` boots `fixtureRoot` + `hubFor` + `startServer` on an ephemeral port, serves the real `src/client`, and seeds 320 runtime-generated JSONL entries (also passed as `FAKE_PI_ENTRIES` so the snapshot offers "load earlier").
- Select surface uses harness injection through the hub's real record path (`hub.onRecord`), as grilled; answer/cancel are asserted against the fake Pi log.
- A2UI panel asserts the client half, including the outgoing action JSON captured with CDP `Network.webSocketFrameSent` (Submit sends the action, Cancel sends its cancel action), then cancel/collapse.
- Load-earlier distance is asserted exactly (0 px). Jump-to-newest uses the floating control and asserts the smooth-scroll clamp: Chrome settles 1 px short of the exact bottom, so the assertion is `0 <= bottom <= 1` (anything larger is a regression). Everything else (overflow, page/console errors) is exact.
- Negative path verified: injected page overflow exits 1; unset `PIXIP_CHROME` prints a skip and exits 0.
- Verified here with `/tmp/pixip-chrome/chrome-headless-shell` and `LD_LIBRARY_PATH=/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu`; `npm run check` is green (daemon tests need `PIXIP_INSIDE` unset in this session).

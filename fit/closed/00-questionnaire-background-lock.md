---
grilled: true
leg: dogfooding-test
project: pi-harness
---

The questionnaire tool can leave the agent permanently busy when the browser/TUI is in the background: no question UI appears, the tool call never returns, and the session locks until interrupted. Make backgrounding either keep the questionnaire answerable when the UI returns or fail/cancel cleanly, so the agent is never left stuck busy.

### Reproduction

1. Start a pi session whose questionnaire UI is the browser (ACP/TUI) and put that browser in the background.
2. Trigger the `questionnaire` tool from the agent.
3. Bring the browser back to the foreground.
4. Observed: no question tabs/sections are shown, the session stays "busy", and there is no way to answer or dismiss the pending questionnaire.

### Expected

- A questionnaire triggered while the UI is backgrounded appears when the UI is foregrounded, with the answers/partial state intact.
- Backgrounding mid-questionnaire does not drop the request or the already-selected answers.
- If the host genuinely cannot collect typed text or show the questionnaire, the tool returns an explicit error/cancel instead of hanging.
- The tool call always settles: no session may stay busy because a questionnaire was raised in the background.

### Investigation

- Locate the questionnaire tool implementation and the UI/transport it uses (harness TUI, ACP adapter, or web host). Confirm whether the backgrounded browser is blocked on a render/focus event, a suspended timer, or an unanswered tool callback.
- Reproduce with the actual host path, not only a unit mock.
- Check adjacent tool behavior: any UI request that waits on a foreground browser should have the same cancellation/timeout guarantee.

### Acceptance

- Automated regression test covers "questionnaire requested while UI is backgrounded, then foregrounded" and asserts the tool either completes normally or returns a clear cancellation.
- A second test covers a host that cannot render the questionnaire and asserts the agent returns to idle with an error, not a pending tool call.
- Normal foreground questionnaires still submit all sections and partial answers as before.
- Harness/package tests and `npm run check` (for the affected repo) are green.
- Manual reproduction from the steps above no longer leaves the agent busy.

### Notes

- Discovered during the dogfooding leg while grilling `00-web-image-upload`: that ticket is paused/open until this is fixed.
- Add findings and the affected checkout/package path here before editing code.

### Decisions (grilled 2026-11-22)

- Scope is **pixip only** for this ticket. The questionnaire plugin and ACP adapter are deliberately out of scope; the plugin will be replaced by a pixip-native question UI later.
- Background/reconnect is handled by caching the current blocking `extension_ui_request` (`select`/`confirm`/`input`/`editor`) on the live session and replaying it to every new subscriber before the snapshot.
- A pending request is not timed out while a client is attached. If the last subscriber detaches, a bounded grace timer settles it with `cancelled: true` so Pi can never wait forever; a reconnect inside the grace window cancels that timer and replays the request with its state intact.
- No new questionnaire protocol or client layout change in this ticket. The existing pixip dialog sheet is reused.

### Findings

- Dogfooding session `tmp/trial/sessions/2026-11-22T02-06-44-900Z_...jsonl` shows the questionnaire waiting from `02:07:48` until the user aborted the turn at `02:13:28`; it was then reported as "user dismissed". A retry lost the dialog again.
- Host is pixip (`pi --mode rpc`). Pi 1.5.2 has no `ctx.ui.panel`, so the plugin uses sequential RPC dialogs.
- `src/hub.ts` caches only fire-and-forget addon UI (`setStatus`/`setWidget`). Blocking `extension_ui_request`s are forwarded once and forgotten, so a reloaded/backgrounded browser never sees them again while the child waits.
- Affected checkout/package: `/home/sloppy/dev/sin/pixip` (`src/hub.ts`, server replay path, tests). No changes to `/home/sloppy/dev/sin/sloppys-pi-slop/plugins/pi_questionare` in this ticket.

### Resolution

- `src/hub.ts` now keeps a per-session `pendingUi` map of unanswered blocking dialogs. `subscribe()` adds the subscriber first and then replays every pending request synchronously, so there is no gap between attach and the live event stream and no duplicate delivery.
- Answering through the existing `ui` frame clears the cached request. Stopping the child or the child exiting clears it too.
- When the last subscriber detaches, each pending request gets the `pendingUiGraceMs` timer (default 120 s). A reconnect clears the timer and replays the request; if nobody returns, the hub sends `extension_ui_response {cancelled:true}` so the waiting extension tool settles.
- `test/fixtures/fake-pi.mjs` records `extension_ui_response` commands for assertions.
- New `test/pending-ui.test.ts` covers reconnect replay followed by an answer, no replay after an answer, and cancellation when no client reattaches.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` → 220/220 tests pass, typecheck clean.
- The env override is required because this agent runs inside a pixip session: inherited `PIXIP_INSIDE=1` makes the daemon tests treat `pixip stop` as an inside restart, which is unrelated to this change.
- `node --test test/pending-ui.test.ts` → 2/2 pass.
- No client assets/layout changed, so no `tools/shot.mjs` run.

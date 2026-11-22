---
project: pixip
grilled: true
commit: "4e5d0ec95bea6e7051177e536de9914d5816563d"
---

Move blocking extension dialogs out of the modal sheet into a collapsible inline surface docked between the transcript and composer, so a pending question can be answered while the user scrolls history. Keep the tool blocking and the existing `extension_ui_response` contract unchanged.

### Layout

- Add a `#surface` slot to `index.html` between `#log` and the `#jump`/dock area, using the same column width as the transcript.
- `#log` remains the only scroll container. The surface stays visible while history scrolls; it is not a modal overlay and has no backdrop.
- Default state is expanded. A collapse control reduces it to a header row with the title and status; a fully expanded state uses the available session height. Long content scrolls inside the surface so the composer stays reachable.
- Collapse state is per request and is not persisted. App-owned sheets (settings, model, tree, export, directory, long notices) stay modal.

### Behaviour

- Route blocking extension UI methods `select`, `confirm`, `input` and `editor` from `handleUiRequest` to the surface. Leave `notify`, addon status/widget and app-owned sheets where they are.
- One active blocking request at a time. If a second request arrives, explicitly cancel the previous one or queue it; never silently overwrite an unanswered request.
- Preserve the existing response fields and exactly-once semantics. Cancel and submit both go through the same `{t:"ui", id, ...}` path.
- Reuse the hub's pending-UI replay and grace timer: a reconnect reopens the surface with the same request.
- Escape cancels only when the surface owns focus, not while typing in the composer. Closing by button follows the same cancel path.
- On answer/cancel, clear the surface. If the user was pinned to the newest entry, stay pinned; if they were reading history, preserve their scroll position.

### Tests

- Fake `select` request: answer, cancel, scroll history up while pending, reload/replay.
- Collapse and expand; long form with internal scrolling; composer remains reachable.
- Second blocking request does not orphan the first.
- `tools/shot.mjs` at 390 and 1280 with a populated transcript and collapsed/expanded surface.

### Out of scope

- A2UI rendering, panel payloads, session-history persistence, app-owned sheet redesign, and framework changes.

### Decisions (grilled 2026-11-21)

- **Second blocking request:** queue it, never cancel or overwrite. The active request stays fully interactive and all drafts stay untouched. A persistent banner in the surface header says e.g. `1 new request waiting` with a **Replace** button. Clicking Replace cancels the old request (`cancelled: true`) and mounts the next; answering or cancelling the old request automatically mounts the next queued request. The banner is not a transient toast and has no auto-dismiss.
- **Sizing:** expanded height follows content up to 70% of the session area; beyond that the surface scrolls internally. Default state is expanded; min state is the header row with title/status and expand + cancel controls.
- **Old modal path:** delete the sheet rendering for `select`, `confirm`, `input`, `editor`; those methods render only in the inline surface. App-owned sheets (settings, model, tree, export, directory, long notices) remain modal.
- **Escape:** cancels only when focus is inside `#surface`; Escape in the composer is untouched. The close/cancel button uses the same cancel path.
- **Scroll:** `#log` stays the only transcript scroll container. Answering/cancelling clears the surface; if the user was pinned to the newest entry they stay pinned, otherwise `scrollHeight - scrollTop` is preserved.
- **Replay:** reuse the hub's pending-UI replay and 2-minute grace timer. Replay queue order is the order the hub cached the requests; the first replays as active, the rest as queued.
- **State:** collapse state is per request and not persisted. Exactly-once response semantics use the existing `{t:"ui", id, ...}` frame.
- **Assumption:** queued requests stay blocking in Pi (no client-side cancellation) until the user replaces or answers; the hub grace timer still applies per request after the last client detaches.

### Acceptance additions

- With two pending `select` requests, the first stays interactive, the banner appears, and Replace cancels exactly the first id then mounts the second.
- Answering the first without Replace automatically mounts the second with its draft intact.
- Reload with two pending requests restores the same active + queued state.

### Verification (2026-11-21)

- Blocking `select`/`confirm`/`input`/`editor` now render in `#surface`; the old modal branch in `sheets.js` was removed. App-owned sheets still use `#sheet`.
- Second request queues behind a persistent `1 new request waiting` + Replace banner; answering/cancelling the active request mounts the next.
- Collapse reduces the surface to a 51 px header; expanded content caps at 70% and scrolls internally (long editor: body 446 px scroll / 436 px client, composer still on screen).
- Escape only cancels with focus inside `#surface`; the jump pill sits above the surface.
- Browser check on Chrome headless at 390x844 and 1280x900: queue/banner, answer, collapse/expand, scroll-position preservation, reload replay, cancel, no console/page errors. Screenshots captured for both widths.
- Unit tests: `test/surface.test.js` (first stays active, duplicates ignored, next promoted, clear without queue); existing pending-UI replay tests green. `npm run check` green (243 tests).

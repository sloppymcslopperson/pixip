---
grilled: true
project: pixip
---

Add a red waiting indicator to the session header and dashboard rows when a session has an unanswered blocking UI request or a recorded timed-out re-ask card. The dot uses a new pink-red `--waiting` colour with a slow breathe; the header also says `waiting for you`.

### Context

The hub already caches blocking `select`/`confirm`/`input`/`editor`/`panel` requests in `live.pendingUi` and stores timed-out re-ask records under `<data-dir>/pending-ui/`. Neither is exposed in `SessionInfo`, so the dashboard cannot show that a session needs a human, and a re-ask card on a stopped session is invisible until opened.

### Decisions (grilled 2026-11-21)

- **Surfaces:** the same waiting dot appears on the session header and on dashboard session rows.
- **Colour:** add `--waiting: #ff9ecb` to `base.css`. It is deliberately distinct from `--err` and `--warn`.
- **Precedence:** `error` wins over `waiting`; otherwise `waiting` wins over `idle`, `busy`, `stopped` and `starting`.
- **Re-ask cards:** any recorded re-ask counts as waiting, including for stopped sessions, until the user asks or dismisses it.
- **Animation:** slow ~2 s breathe between full and dimmed `--waiting`; `prefers-reduced-motion: reduce` renders a solid dot.
- **Text:** the session subtitle says `waiting for you`; the dashboard row state reads `waiting · <relative time>`.
- **Queued requests:** the indicator stays on until the last live request and the last re-ask record are gone.
- **No tab-title or favicon change** in this ticket.

### Scope

- Add `awaitingUser?: boolean` to `SessionInfo` in `src/wire.ts`.
- Derive it in the hub from live pending UI **or** on-disk re-ask records.
- Keep it current on cache, answer, cancel, timeout, re-ask ask and re-ask dismiss.
- Refresh both `status` and `sessions` frames when it changes so the header and dashboard rows update without reopening.
- Add a pure client `displayState(info)` helper where `error` wins, then `waiting`.
- Render the waiting dot and text in `sessionView.js` and `dashboardList.js`.
- Add `--waiting` and the breathe keyframes in `base.css`.

### Acceptance

- A live pending questionnaire shows the waiting dot in the header and on the dashboard row.
- Answering or cancelling the last request clears the dot without a reload.
- A timed-out request leaves its session waiting while the re-ask card is recorded, including after the session is stopped.
- Clicking re-ask or dismiss clears the stopped session's waiting dot.
- A session in `error` shows the error dot, not the waiting dot.
- With `prefers-reduced-motion`, the waiting dot is solid.
- The indicator is readable at 390 and 1280 px and does not change layout.
- `npm run check` is green.

### Tests

- Hub: live request sets `awaitingUser`; answer/cancel/timeout clears it; two queued requests stay true until the last clears.
- Hub: an accepted re-ask record sets it for a live session and for `list()` after the session is stopped; ask/dismiss clears it.
- List: a stopped session with a recorded re-ask is listed as waiting.
- Client: `displayState` precedence (`error` over `waiting`, `waiting` over busy/idle/stopped/starting).
- Browser check via `tools/shot.mjs` at 390 and 1280: live panel, dashboard row, stopped session with a re-ask card.

### Files

- `src/wire.ts`
- `src/hubLive.ts`
- `src/hubStore.ts`
- `src/client/sessionInfo.js`
- `src/client/sessionView.js`
- `src/client/dashboardList.js`
- `src/client/base.css`
- `ARCHITECTURE.md`
- hub/client tests plus `tools/shot.mjs` fixtures as needed

### Edge cases

- A re-ask record can exist without a live child; do not require an attached session to show waiting.
- Re-ask records are keyed by logical id, so use the same `pendingUiKey` rules as the storage layer.
- The session may stop or re-key while waiting; keep the flag tied to the logical session where possible.
- Timeout first removes the live request and then records the re-ask; the indicator must not flicker off permanently in between.
- Do not add a second dot style that changes the dashboard row height.

### Out of scope

- Browser tab title or favicon changes.
- Web Push, sound or haptics.
- Changing the inline surface, composer hiding, or answer semantics.
- New authentication or protocol frames beyond the `SessionInfo` field.

### Verification

- `npm run check` green.
- `tools/shot.mjs` at 390 and 1280 for the three states above.
- Update `ARCHITECTURE.md` pending-UI/status text with the re-ask meaning of `awaitingUser`.

### Environment note for `/fit work`

`npm run check` can fail from inside a pixip-managed Pi session because the unresolved `open/20-test-harness-pixip-env.md` leaks `PIXIP_INSIDE`/`PIXIP_SESSION_ID` (and the caller's `PI_SESSION_*`) into the daemon lifecycle tests. Run the check with `PIXIP_INSIDE`, `PIXIP_SESSION_ID`, `PI_SESSION_ID` and `PI_SESSION_FILE` unset, and note that in the verification instead of treating it as a regression from this ticket.

### Outcome

Implemented `SessionInfo.awaitingUser`, derived in `list()` from live pending UI or on-disk re-ask records and refreshed on request cache/answer/cancel, re-ask record/dismiss, stop, child exit and reattach. A change emits both `status` and `sessions` frames. Added `displayState()` with `error > waiting > state` precedence, the pink-red `--waiting` dot with a 2 s breathe and reduced-motion fallback, header text `waiting for you`, and dashboard row text `waiting · <relative time>`. Updated `ARCHITECTURE.md`.

Verification:
- `npm run check` green with `PIXIP_INSIDE`, `PIXIP_SESSION_ID`, `PI_SESSION_ID` and `PI_SESSION_FILE` unset.
- `tools/shot.mjs` at 390 and 1280 for the dashboard row, live panel/header, and stopped-session re-ask/header: no overflow, console errors, or layout height change.
- Tests added for two queued live requests, cancel/answer clearing, stopped-session list waiting, reattach preserving the re-ask, dismissal clearing it, and `displayState` precedence.

---
project: pixip
grilled: true
commit: "6d6cefa6b0d52de26cb3513a611f72e1dde54ab8"
---

Split `composer.js` and `session.js` along their existing seams: composer controller, attachments and bash cards; session open/restore/cache, routing and frame effects. Extract pure helpers and keep the DOM controllers thin.

### Work

- Composer: separate input/send/command dispatch from attachments and bash-card lifecycle; keep attachment encoding/validation pure and tested.
- Session: separate open/restore/cache from frame effects and routing; move frame-driven state changes into explicit handlers called by the protocol adapter.
- Keep the inline surface and panel wiring out of the composer/session controllers except through narrow calls.
- Preserve optimistic user blocks, queue handling, reconnect behaviour, scroll pinning and footer rendering.

### Acceptance

- No composer/session module owns three unrelated concerns.
- Existing composer flows still work: text, slash commands, bash, image/file attachments, queue chips, stop.
- Session open, reattach, `/new` re-key, snapshot/history and reconnect still behave as before.
- Pure helpers have tests; `npm run check` green; 390/1280 screenshots unchanged.

### Out of scope

- Transcript windowing (`11-transcript-seam`), new composer features, and protocol changes.

### Grilling

- **Composer: split and extract.** Keep the acceptance as written. `composer.js` becomes the thin controller (input/dispatch/submit/commands), new `composerAttachments.js` owns attachment choice/render/upload lifecycle, new `composerBash.js` owns bash submit/append/finish card lifecycle. `attachments.js` remains the pure engine.
- **Composer pure helpers to extract and test:** file validation (size/type limits and image-vs-file decision), image encode math (thumbnail dimensions/fit and canvas-to-blob type/quality selection, DOM-free), outgoing payload shaping (image/file prompt payloads as pure functions), and bash card state shaping where it is not already covered by `render.js` tests.
- **Session: session + effects.** `session.js` keeps open/pending/restore/cache. New `sessionEffects.js` holds frame-driven state changes as explicit handlers; `frames.js` remains the protocol adapter and calls them. Routing stays in `navigation.js`. No new `sessionCache.js` module; expand the existing pure cache helpers there if needed.
- **Session tests: both.** Add DOM-free tests for cache snapshot/restore shape, distance computation and queue copying, plus a pure frame-effect handler/reducer returning state changes.
- **Preserve** optimistic user blocks, queue handling, reconnect, scroll pinning and footer rendering. The inline surface and panel wiring stay outside the controllers except through narrow calls.

### Implementation note

- Composer controller is now 211 lines: command dispatch, policy gating, submit and quit only. `composerAttachments.js` owns the attachment UI/upload lifecycle, `composerBash.js` owns bash cards, and `attachments.js` gained the pure engines `fitImage`, `imageSourceError`, `uploadError`, `outgoingText`, `imageBlocks`, `slashPayload`, `textPayload` and `optimisticContent`.
- Session frame effects moved into `sessionEffects.js` (snapshot/restart/status/opened/close plus replacement snapshots). `frames.js` is now a thin protocol switch. Decisions live in the DOM-free `sessionPlan.js` (`snapshotPlan`, `openedPlan`, `statusPlan`, `closePlan`), so they are testable.
- `sessionCache.js` gained `readingDistance`, `copyQueue`, `snapshotSession` and `restoreSession`; `session.js` uses them for cache/restore.

Verified with `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` (all suites green, 302 root tests) and screenshot/interaction probes at 390 and 1280: dashboard, transcript, attach menu toggle and `/` menu, no console errors. Parent commit `6d6cefa6b0d52de26cb3513a611f72e1dde54ab8`.

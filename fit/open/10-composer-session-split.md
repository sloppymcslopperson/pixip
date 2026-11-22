---
project: pixip
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

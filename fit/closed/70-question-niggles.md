---
grilled: true
commit: "9bdf8a1286493ea4c0679de48e72b64e85eccd0d"
---

Question niggles: the panel shows the extension's name twice, and the composer stays available while a blocking surface is up. Fix the duplicate title generically and hide the composer while any blocking request is active.

### Decisions

- Duplicate title: keep the inline surface header title (and its collapse/close controls). In the A2UI renderer, hide an in-panel `Text` component when its text duplicates the surface header title. Apply this generically to any A2UI panel, not just the questionnaire extension.
- Composer: hide it while any blocking request is active (`select`, `confirm`, `input`, `editor`, `panel`), not only panels. Restore it when the surface settles.
- Preserve the existing unsent composer draft. While hidden, prompt submission must be blocked rather than queued.
- Keep the existing focus/draft behavior for the session and surface; no duplicated markup per breakpoint.
- Add client tests for the title dedupe and composer visibility/submit blocking. Verify with `tools/shot.mjs` at 390 and 1280.
- The `Submit` → `Submit all` label is a separate follow-up ticket, not part of this one.

### Out of scope

- Changing the composer layout or adding a second input inside the surface.
- Panel-specific composer behavior; the rule is one behavior for all blocking requests.

### Verification

`npm run typecheck`, `npm run lint`, `npm run format:check` and the full `npm test` suite (333 tests) pass. `tools/shot.mjs` was not run: this environment has no Chromium/Chrome binary and no `PIXIP_CHROME`; the owner runs the 390/1280 screenshots per the repo notes.

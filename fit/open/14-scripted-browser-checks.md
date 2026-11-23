---
project: pixip
---

Add deterministic scripted browser coverage for the main client flows using an in-process Hub/server, `fake-pi` fixtures and the real `src/client` assets. The script must catch page errors, horizontal overflow and flow regressions at 390 and 1280.

### Work

- Add `tools/browser-check.mjs` using the existing `puppeteer-core` dev dependency and `PIXIP_CHROME`; no new runtime dependency.
- Boot an isolated fixture Hub/server on an ephemeral port (`fixtureRoot`, `hubFor`, `startServer`, real `src/client` clientDir) and seed a session with enough JSONL history to offer “load earlier”.
- Run every flow at 390x844 and 1280x900:
  - dashboard → session open;
  - composer submit and optimistic echo (assert the fake Pi prompt log);
  - plain inline `select` surface: answer, cancel and collapse;
  - A2UI fixture panel via the existing `?panel=fixture` dev route: answer/cancel/collapse using the real panel path;
  - history load-earlier preserves the reading distance and jump-to-newest returns to the bottom.
- Assert `pageerror`/console errors are empty and `document.documentElement.scrollWidth <= innerWidth` at both viewports.
- Add a `check:browser` npm script and include it in `npm run check`; when `PIXIP_CHROME` is unset print a clear skip and exit 0, when set it must fail hard on any problem.
- Update README testing notes with the `PIXIP_CHROME` invocation and the script path.

### Acceptance

- The script passes against the real client at 390 and 1280 with the local headless Chrome and exits non-zero on an injected page error/overflow.
- `npm run check` includes `check:browser` and stays green without Chrome by skipping.
- No production protocol or hub change; fixtures stay in `test/fixtures`.

### Depends on

- Ticket 12 for stable shared selectors/imports. Ticket 13 is not required for the browser flows, but should be merged before the final guard commit.

### Decisions from grilling

- In-process fake Pi, not a live daemon.
- Full deterministic flow assertions, not smoke-only.
- Cover both the plain select surface and an A2UI fixture panel.
- Commit as one logical ticket commit after the checks are green.

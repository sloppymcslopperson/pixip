---
grilled: true
---

Derive a session label from its first prompt by asking a separate one-shot Pi process to summarize it into three to five words, then set it as the Pi session name. The user can still rename the session from the UI, and manual names always win over automatic labels.

### Decisions

- **Summarizer:** spawn a short-lived `pi --print --no-session` process with tools/extensions/context files disabled; the real session transcript and context are untouched.
- **When:** only on the first prompt of a session that has no messages and no name (new sessions created in pixip). Existing unnamed sessions are not backfilled.
- **Name source:** persist `nameSource: "auto" | "manual"` in `sessions.json`. A manual rename wins; never overwrite any existing name at first prompt.
- **Model:** configurable via `--title-model <provider/model>` and `PIXIP_TITLE_MODEL`; the default is the cheap `deepseek-v4.1-flash` when the session reports it as available, otherwise the session's own model.
- **Fallback:** if the one-shot call fails, times out (15 s), or returns nothing useful, derive a local 3-5 word label from the first prompt.
- **Format:** sentence case, 3-5 words, no surrounding quotes, max 40 characters.
- **UI:** the existing name surfaces update through the normal `status` frames; no new client control for triggering the label.

### Acceptance criteria

- Sending the first prompt to a new unnamed session produces a 3-5 word name that appears in the dashboard, header/status line and `/session`.
- A session that already has a name at first prompt is never relabeled.
- A manual rename before or after labeling is never overwritten by the automatic label.
- Summarization runs off the prompt hot path: prompt dispatch is not delayed, and failures fall back without a toast or transcript entry.
- The chosen model is configurable; unavailable/default missing models fall back to the session model.
- `npm run check` is green, including tests for auto label, manual-wins, fallback and model resolution.

### Implementation

- `src/titles.ts`: pure `normalizeTitle`, `fallbackTitle` and bounded `titlePrompt` helpers; sentence case, 3-5 words, 40 chars.
- `src/hub.ts`: first-prompt trigger on `prompt`, separate `pi --print --no-session` one-shot child, model resolution (configured → cheap default → session model), 15 s timeout, local fallback, `nameSource` persistence, and manual rename protection.
- `sessions.json` records `nameSource`; archive/trash metadata preserves it, and restore keeps it.
- `bin/pixip.ts`: `--title-model <provider/id>` and `PIXIP_TITLE_MODEL`; help text updated.
- `test/fixtures/fake-pi.mjs`: one-shot print mode for title tests (reply/failure/delay).
- Tests: `test/titles.test.ts` (normalization/fallback/prompt), `test/title-hub.test.ts` (auto label, manual wins, fallback, model choice/fallback).
- `ARCHITECTURE.md` and `README.md` document the feature.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check`: 187 tests pass, typecheck green.
- Real one-shot command verified against the installed Pi: `pi --print --no-session --no-tools --no-extensions … --model opencode-go/deepseek-v4.1-flash …` returned a clean 3-5 word label.
- No client layout changed; the existing name surfaces consume the normal `status`/`sessions` frames.

---
grilled: true
leg: follow-up
project: pixip
---

Automatic session titles still fell back to the first prompt words because the one-shot `pi --print` title child waited forever for stdin EOF. `execFile` left the pipe open, so every title call hit the 15 s timeout even after switching to the session model.

### Root cause

- `runTitlePi` used promisified `execFile`, whose child stdin is an open pipe.
- Pi's print mode waits for stdin EOF before starting, so the title child produced no output and was killed at the timeout.
- Manual shell runs and `spawn(..., stdio: ["ignore", ...])` succeeded, which hid the problem from the earlier investigation.

### Fix

- Close the title child's stdin immediately after spawning it.
- Keep the existing timeout and stderr capture.
- Add a fake-Pi regression mode that only answers a print-mode call after stdin EOF, so leaving the pipe open fails the title test.

### Verification

- `node --test test/titles.test.ts test/title-hub.test.ts` passes.
- A direct `execFile` reproduction without `stdin.end()` times out; with it, the same prompt returns a label in ~2.5 s.
- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` → 221/221 pass, typecheck clean.

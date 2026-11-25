---
grilled: true
---

Compaction doesn't work well right now. When the user hits /compact, the transcript must represent the new compaction boundary correctly, and while compaction runs it must show persistent progress and lock the composer.

### Decisions (grilled 2026-11-21)

- Manual and automatic compaction are both in scope.
- The transcript keeps the full history; summarized entries are not removed. After a successful compaction a visible boundary appears at its chronological position.
- The boundary is a collapsed one-line `compacted` row that expands to the summary body. Its label carries tokens before, the estimated tokens after when available, duration and a clock timestamp.
- While compaction runs, show a persistent transcript status block with the phase (`manual` / `threshold` / `overflow`) and an elapsed timer, not just a toast.
- The composer is disabled for all compaction, manual and automatic. An unsent draft is preserved. Auto-compaction is announced the moment `compaction_start` arrives; a pre-start confirmation is impossible because Pi starts summarizing before the event reaches pixip.
- On success the client requests a replacement snapshot and refreshes the footer. On abort/error it removes the status block, leaves history untouched and toasts the outcome.
- Cancellation is split into its own ticket. Reusing pre-compaction messages ("remind the agent") is split into its own ticket.

### Acceptance

- `/compact` shows `compacting context (manual)… Ns`, disables the composer, and replaces the transcript with a full-history snapshot that includes a collapsed compaction boundary; `load earlier` still works.
- Threshold/overflow compaction shows `compacting context (threshold|overflow)… Ns`, locks the composer, inserts the same boundary and refreshes the footer without a manual `/compact`.
- The boundary expands to the summary and shows tokens before/after (after while known), duration and time.
- An aborted or failed compaction restores the composer, adds no boundary, and reports `compaction cancelled` / `compaction failed: …`.
- `npm run check` green; client screenshots at 390 and 1280.

### Tests

- Pure render tests for boundary label/HTML and compaction status text.
- Client event handling test for start → indicator/lock, success → resnapshot + boundary, abort/error → no resnapshot and unlocked composer.
- Existing builtin socket test still passes (`compaction_end` → replace snapshot).

### Outcome

Implemented `src/client/compaction.js` plus small hooks in `transcript.js`, `sessionEffects.js`, `sessionView.js`, `sendState.js`, `render.js` and `transcriptView.js`:

- `compaction_start` shows a persistent `compacting context (<reason>)… Ns` row, updates once a second, mentions a kept draft, and locks the composer. Manual and automatic compaction both take this path.
- `compaction_end` distinguishes success from abort/error: success stores the event's `estimatedTokensAfter`/duration, clears the row and asks for a replacement snapshot; abort/error clears the row, unlocks the composer and toasts, without rewriting history.
- The snapshot keeps full history. The newest `type: "compaction"` entry renders as a collapsed `compacted` boundary with the summary inside and a label carrying duration, tokens before/after (after while known) and local clock time. `load earlier` is unchanged.
- Replacement snapshots drop stale streaming/pending DOM references so a live delta cannot write into a detached node.
- The hub schedules a footer refresh on every `compaction_end`, which also covers automatic compaction.

Tests: pure render tests for labels/boundary/status text, the socket test now asserts the replacement window carries the compaction boundary, and `tools/browser-check.mjs` gained a compaction flow (status row, composer lock/unlock, boundary expand). `npm run typecheck`, `npm run check:imports`, Prettier and targeted ESLint are green; the suite passes except the known environment-dependent daemon/title flakes.

Browser screenshots were not taken because the staged Chrome at `/tmp/pixip-chrome/.../chrome-headless-shell` is missing `libatk-1.0.so.0`; the path and install note are in the gitignored `tmp/CHROME.md`.

Follow-ups: `open/10-cancel-compaction.md` and `open/20-remind-from-pre-compaction.md`.

### Browser verification update

The staged Chrome runs without a system install when `LD_LIBRARY_PATH=/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu` is set (documented in the gitignored `tmp/CHROME.md`). `npm run check:browser` now passes both 390 and 1280 viewports, including the new compaction flow. A scripted demo produced the status row, composer lock, collapsed boundary and expanded summary screenshots under `tmp/shots/` (`compaction-390-*`, `compaction-1280-*`). This supersedes the earlier note that screenshots could not be taken.

The fake Pi fixture gained `FAKE_PI_COMPACTION_DURATION_MS` so compaction start and end are separate ticks; the browser flow uses it to observe the progress row.

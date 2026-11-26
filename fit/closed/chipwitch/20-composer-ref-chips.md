---
grilled: true
project: pixip
series: chipwitch
---

When a ref tag is typed or pasted into the composer, show a neat chip above the input naming the source (session or inbox) and the first few words, resolved from state the browser already holds.

### Resolution tiers

1. `state.entries` — the open session: exact role, time and text.
2. `sessionCache` (last 8 viewed sessions keep their window) — the "I just came from there" case.
3. The `sessions` frame — always in memory for every session: name, cwd, branch, state. Name-only chip, no excerpt.
4. One `GET /api/inbox`, cached in the kernel, for inbox refs (`InboxSummary` carries only the newest message, so the list is a fetch).
5. Miss → muted `unresolved` chip.

### Decisions

- The tag stays in the textarea and is exactly what is sent. The chip is display-only, never rewrites the text, and needs no new prompt field or hub change.
- Removing a chip deletes its token; nothing else is mutated.
- No fetch per keystroke and none at send; the inbox list is fetched at most once per daemon connection.
- Detection rides the existing composer paste listener (`src/client/app.js`) plus the `input` event; no `contenteditable`.

### Acceptance

- Paste and typing both produce chips; multiple refs produce multiple chips, duplicates collapse, and the row wraps at 390 px.
- Chip content: inbox → source, purpose, subject; history → source, session name, role, time, first ~8 words of the body.
- A stale or unknown ref shows a muted `unresolved` chip and the send still goes through.
- `npm run check` green, `tools/browser-check.mjs` gains a paste-a-ref flow, plus shots at 390 and 1280.

### Boundaries

- The tag in the textarea is the prompt. Do not add a `refs` field to the socket, do not change `submitText`/`slashPayload`, do not touch `src/wire.ts` or `src/hubControl.ts`.
- Inbox data comes from the existing `GET /api/inbox`. No hub changes and no new frame.
- Respect the client import guard (`tools/check-client-imports.mjs`): composer and inbox are separate clusters. Share through kernel state and `configureX({ ... })` callbacks, never by importing `inbox.js` from `composer.js` or the reverse.
- Same hot-reload fence as `00-ref-grammar`.
- Board writes stay inside `fit/{open,closed}/chipwitch/`.

### Testing

- `npm run check` green, including `check:imports` and `check:browser`.
- Manual at 390 and 1280: one ref, several refs, the same ref twice (dedupe), a malformed `[ref=…]` (renders as text), a ref to a never-opened session (name-only chip), and a deleted inbox id (muted chip).
- Watch the devtools network panel while typing: no request per keystroke, and the inbox list fetched at most once per connection.
- Send a ref-only message and read it back from the transcript to prove the raw tag was what reached Pi.
- `node tools/shot.mjs` at 390 and 1280.

### Browser verification (required)

- `tools/shot.mjs` is a layout probe, not evidence. Drive the flow for real.
- With this worktree's daemon on `http://127.0.0.1:8138/`, use the **agent-browser** tool to type a tag into the composer, then send it, at 390 and 1280; capture the chip row and assert the sent message kept the raw tag.
- Put a ref tag on the clipboard and exercise the paste path. Typing does not fire a `paste` event: cover that in `tools/browser-check.mjs` with a synthetic `ClipboardEvent` (`page.evaluate`), and keep the typed path for the interactive run.
- Request counting (no fetch per keystroke, one inbox fetch per connection) belongs in the scripted check, where the fixture server can count requests; report the numbers.

  ```bash
  PIXIP_CHROME=$(ls -d ~/.agent-browser/browsers/chrome-*/chrome | tail -1) npm run check:browser
  ```

- `npm run check` silently skips `check:browser` when `PIXIP_CHROME` is unset. Say explicitly which of the two you ran.

### Decisions (grilled)

- Chip body is inert in this ticket. Removing a chip is only through the × that appears on tap; a second gesture for navigation is deliberately deferred to the optional `open/chipwitch/60-reftag-chip-navigation.md`.
- Resolution goes through a new cluster-neutral module (`src/client/reftagResolve.js`) that imports no feature cluster. `app.js` wires the providers with `configureRefTagResolve({ sessions, cache, inbox })`; composer and inbox stay unimported from each other.
- Inbox refs fetch `GET /api/inbox?all=1&filter=all` on the first inbox tag in the composer, then reuse that list for the daemon connection; an `inbox` frame refreshes it. No fetch per keystroke and none at send.
- Chip labels: history → session name (fallback short logical id) · role · HH:MM · first 8 words; inbox → sender/name · purpose · subject truncated. Duplicates collapse; unknown/stale refs get a muted `unresolved` chip and the send still goes through.
- The first ~8 words / subject limits are named constants now, with a comment pointing the future config.toml ticket at them.
- Session-cache entries are keyed by Pi id; resolution maps the ref's logical session id through `state.sessions` before reading `state.sessionCache`. A logical id that cannot be mapped falls through to tier 3.

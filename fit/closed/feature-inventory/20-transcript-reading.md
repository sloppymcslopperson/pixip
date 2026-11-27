---
area: transcript-reading
part: inventory
project: feature-inventory
commit: bf5b97491a6021f34633cb431371bcb9a80cf671
---

Capture everything a user does while reading a session: streamed messages, live thinking, tool and bash output, images, long-history navigation, and transcript readability controls. This is the core reading surface and the largest single area.

### Goal
An inventory reader should understand what the transcript shows, how it streams and reflows, how a user inspects or collapses detail, and how very long sessions stay navigable.

### Scope
- Streamed user/assistant text, Markdown rendering, code blocks, and error styling.
- Live thinking marker, streamed thought disclosure, collapse/expand, and the final per-message thinking box.
- Tool cards (generic and bash): arguments, streamed output, ANSI rendering, durations, errors, exit codes, truncation and full-output retrieval.
- Meta and compaction notices; agent-shown images; user attachments and image previews inside the transcript.
- Inline ref chips and `[pixip-ref=…]` navigation (grammar owned by the refs section; rendering and tap behaviour here).
- Scrolling: native scroll, append-only growth, stable position on prepend, live-follow cursor, `jump to newest`, `load earlier`, transcript windows, and lazy full-entry expansion for truncated blocks.
- Readability: `A−`/`A+` seven-step transcript-only scale, long-press reset, keyboard shortcuts, and persistence.

### User stories to cover
- As a reader on a phone, I want messages to reflow with no horizontal scroll and stay scrolled where I was.
- As a reader, I want to watch the agent think and inspect the full thought without it cluttering the final answer.
- As a reader, I want tool output collapsed by default but expandable, including ANSI colour and long output.
- As a reader of a long session, I want to load older history and jump back to the newest message without losing my place.
- As a reader, I want to make transcript text larger without resizing the composer and chrome.

### Wireframes (SVG, no screenshots)
- Series of screens: transcript anatomy (user, assistant, thinking, tool, bash, meta), collapsed vs expanded tool/thinking, long-session with load-earlier and jump controls.
- Decision-flow diagram: entry arrives -> stream vs snapshot, truncated -> expand, scrolled away -> follow vs jump, tool running -> result.

### Technical notes (port-relevant only)
- The bounded JSONL window, snapshot/resume delta, entry dedupe, and 8 KB per-entry cap; why full history is never requested.
- The volatile live-thinking buffer, its caps and clearing points, and the `live_thinking` frame on reattach.
- Scroll anchoring and the one-scroll-container rule; which rendering must stay pure for tests.

### Sources to read
`src/client/transcript*.js`, `thinkingStream.js`, `liveThinking.ts`, `render.js`, `markdown.js`, `scroll.js`, `transcriptScale.js`, `transcriptScroll.js`, `transcriptWindow.js`, `transcriptView.js`, `transcript.css`, `src/wire.ts`, `ARCHITECTURE.md` (data flow, live thinking), `ui_work/UI_WIDGET_BREAKDOWN.html` (transcript sections).

### Acceptance
- Every transcript widget in the widget breakdown is covered.
- Streaming, reattach, prepend and truncation edge cases each have a story or note.
- SVG wireframes show the workflow, not a screenshot; no horizontal overflow in the report at 390 or 1280 px.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, in a separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/20-transcript-reading.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

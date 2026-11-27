---
area: composer-input
part: inventory
project: feature-inventory
---

Capture how a user composes and sends input: prompting, steering, stopping, queuing, attachments, slash commands, bash escape hatches, and command policy. This section covers the composer row, its menus, and every way text or files enter a session.

### Goal
An inventory reader should understand the full input model: when a message is a prompt, a steer, a follow-up or a bash card, and what the user can attach or invoke.

### Scope
- Composer row: contenteditable input, placeholder, autosize, 16 px no-zoom behaviour, send button, Enter behaviour, empty state.
- Send while idle, steer while streaming, stop/abort, and the pending queue chips with their verbatim `queue_update` behaviour.
- Attachments: `+` menu for photo/camera or arbitrary file, client-side downscale, upload path under the data dir, removable inline preview, clipboard paste.
- Command menu from `get_commands`, slash-command passthrough for extension commands, templates, skills, and `/` filtering.
- `!cmd` and `!!cmd` bash cards: streaming output, exit code, truncation, and `!!` exclusion from model context.
- Per-session command policy: `pixip.json`, allow/deny lists, `--no-bash`, and restrict-only semantics.
- Composer editor, draft preservation while a blocking panel is up, and refusal to submit over a surface.
- Inline composer ref chips (grammar owned by refs; insertion/removal behaviour here).

### User stories to cover
- As a user, I want to send a message, steer a running agent, or stop it without hunting for a modal.
- As a user, I want to attach a photo or file from my phone and see exactly what will be sent.
- As a user, I want to discover slash commands and run a shell command, while knowing `!!` stays out of the model context.
- As an admin, I want to restrict which shell commands a session can run without changing the agent's own settings.
- As a user, I want my draft kept when an extension asks a question.

### Wireframes (SVG, no screenshots)
- Series of screens: composer idle, streaming with queue chips, attachment preview, command menu, bash card states.
- Decision-flow diagram: submit -> idle prompt vs busy steer vs command vs bash; attach -> image vs file; blocked by policy -> refusal.

### Technical notes (port-relevant only)
- The prompt/steer/followUp mapping, why an idle steer still needs `prompt` with `streamingBehavior: "steer"`, and where the queue chips come from.
- Upload handling, attachment handoff as a path, and the command-policy resolution order.
- Which parts are client-only and must stay framework-free.

### Sources to read
`src/client/composer*.js`, `attachments.js`, `commands.js`, `menu*.js`, `queue*.js`, `sendState.js`, `composer.css`, `src/attachments.ts`, `src/commands.ts`, `docs/TUI-parity.md`, `ARCHITECTURE.md` (composer commands, attachments), `ui_work/UI_WIDGET_BREAKDOWN.html` (composer sections).

### Acceptance
- Prompt/steer/stop/queue/attachment/command/bash/policy each have a story and an edge-case note.
- SVG wireframes show each state, not a screenshot.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/30-composer-input.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

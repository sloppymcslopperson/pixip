# Transcript reading

The transcript is where a pixip session is read: one append-only column of typed blocks that grows while the agent works and stays stable while the reader scrolls back. A reader can watch a thought arrive and fold it away, open tool and bash cards only when output matters, enlarge the text without moving the composer, load older history a window at a time, and jump back to the newest message. This area inventories that surface; composing, ref grammar, extension dialogs and session controls have their own areas.

## Contents

- [User stories](#user-stories)
- [The reading surface](#the-reading-surface)
- [Watching a turn arrive](#watching-a-turn-arrive)
- [Thinking, live and finished](#thinking-live-and-finished)
- [Tool cards and bash output](#tool-cards-and-bash-output)
- [Images in the transcript](#images-in-the-transcript)
- [References inside messages](#references-inside-messages)
- [Reading a long session](#reading-a-long-session)
- [Transcript readability controls](#transcript-readability-controls)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a reader on a phone, I want answers to reflow without sideways scrolling, so I never pan a paragraph or code block.
- As a reader, I want to watch the agent think and then keep it folded under the answer, so reasoning is available without competing with the reply.
- As a reader, I want tool and bash output folded with name, arguments and duration visible, so an investigating agent does not bury the conversation in logs.
- As a reader debugging, I want to open a card and ask for the full text of one truncated block without loading the whole session.
- As a reader of a long session, I want to load older history a window at a time and jump back to the newest message without losing my place.
- As a reader who scrolled up, I want new output to arrive without yanking me to the bottom.
- As a reader with tired eyes, I want larger transcript text while composer, header and footer stay the same size.
- As a reader who reconnects mid-turn, I want the streamed text and current thought restored.

## The reading surface

The session screen is a header, the transcript column (`#log`), the inline extension surface, the composer and the footer. `#log` is the only scroll container: a centered column of at most 104 characters, a flex column with a 10 px gap whose children keep their natural height so a tool card cannot collapse to its border. Blocks are typed by producer and history versus transient.

A **user block** has a blue rail and a `you` label. Its text is literal with newlines preserved, so a pasted stack trace reads as sent; recorded image attachments appear as tappable thumbnails.

An **assistant block** has the accent rail and a `pi` label. Its Markdown — headings, lists, tables, fenced code — renders once per message, never per delta. Fenced code scrolls inside its own box, so the page never scrolls sideways; thinking folds above the answer and tool calls appear as cards below it.

A **tool card** is folded by default: name in warning colour, a one-line argument summary, and the duration once it ends. Opening it reveals ANSI-coloured output capped at 60 % of the viewport and scrolling internally; errors tint the name and empty calls are inert.

A **bash card** is the `!`/`!!` sibling: green `$` prompt, command, optional `excluded` badge, streamed output, and a meta line with exit code, cancellation, truncation or the full-output path. A running card says `running…`; a non-zero exit tints it red.

**Meta blocks** are the quiet rail: the `compacted` boundary disclosure, branch summaries, extension notes, local restart and reload notices, the `starting session…` hint and the empty-transcript placeholder. Local notices are never written to the session file.

Two things sit in the flow without being history: the **peer notice** banner when another live session shares the directory, and the floating **jump to newest** pill.

<svg viewBox="0 0 360 640" width="100%" style="display:block;width:100%;max-width:360px;height:auto" role="img" aria-label="Wireframe of the session transcript, showing header, user, assistant, thinking, tool, bash, compaction and image blocks above the composer and footer">
  <rect x="8" y="4" width="344" height="632" rx="18" fill="#16141f" stroke="#322b45"/>
  <text x="22" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#9b93b4">‹</text>
  <text x="38" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">fix transcript scroll</text>
  <text x="300" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">● ⋯</text>
  <line x1="8" y1="36" x2="352" y2="36" stroke="#322b45"/>
  <circle cx="26" cy="54" r="7" fill="#241f33"/><text x="23" y="57" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">1</text>
  <rect x="20" y="46" width="2" height="52" fill="#7aa2f7"/>
  <text x="30" y="52" font-family="ui-monospace, monospace" font-size="8" fill="#7aa2f7">YOU</text>
  <text x="30" y="68" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">load earlier keeps my place</text>
  <text x="30" y="82" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">while output still streams.</text>
  <text x="30" y="96" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">2 image thumbnails</text>
  <circle cx="26" cy="118" r="7" fill="#241f33"/><text x="23" y="121" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">2</text>
  <rect x="20" y="110" width="2" height="86" fill="#bb9af7"/>
  <text x="30" y="116" font-family="ui-monospace, monospace" font-size="8" fill="#bb9af7">PI</text>
  <text x="30" y="132" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">The scroll distance is held</text>
  <text x="30" y="146" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">when a window prepends.</text>
  <rect x="30" y="156" width="230" height="32" rx="4" fill="#241f33"/>
  <text x="38" y="170" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">#log { overflow-y: auto }</text>
  <text x="38" y="182" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">code scrolls inside its box</text>
  <circle cx="26" cy="214" r="7" fill="#241f33"/><text x="23" y="217" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">3</text>
  <text x="34" y="212" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">▸ thinking</text>
  <circle cx="26" cy="240" r="7" fill="#241f33"/><text x="23" y="243" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">4</text>
  <rect x="34" y="226" width="300" height="28" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="42" y="244" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">read</text>
  <text x="74" y="244" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">src/client/scroll.js</text>
  <text x="296" y="244" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">4ms</text>
  <circle cx="26" cy="290" r="7" fill="#241f33"/><text x="23" y="293" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">5</text>
  <rect x="34" y="264" width="300" height="76" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="42" y="280" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">$</text>
  <text x="54" y="280" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">npm run check</text>
  <text x="42" y="296" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">typecheck… ok</text>
  <text x="42" y="310" font-family="ui-monospace, monospace" font-size="9" fill="#cfc9e0">tests… 214 passing</text>
  <text x="42" y="328" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">exit 0 · 42s</text>
  <circle cx="26" cy="362" r="7" fill="#241f33"/><text x="23" y="365" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">6</text>
  <text x="34" y="360" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">▸ compacted · 44 msgs → ~9k tokens</text>
  <circle cx="26" cy="400" r="7" fill="#241f33"/><text x="23" y="403" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">7</text>
  <rect x="34" y="384" width="300" height="58" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="42" y="400" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">show_image_to_user</text>
  <rect x="42" y="408" width="44" height="26" rx="3" fill="#322b45"/>
  <text x="94" y="418" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">caption + download original</text>
  <rect x="212" y="452" width="112" height="24" rx="12" fill="#241f33" stroke="#322b45"/>
  <text x="222" y="468" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">↓ jump to newest</text>
  <rect x="20" y="496" width="320" height="56" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="32" y="520" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">message pi…</text>
  <text x="32" y="540" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">composer keeps 16 px whatever the scale</text>
  <text x="22" y="576" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">~/dev/pixip (main) • fix transcript scroll</text>
  <text x="22" y="590" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">14.2k tok · $0.41 · 38% ctx</text>
  <text x="22" y="604" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">anthropic/claude · thinking high</text>
</svg>

1 user block · 2 assistant block with fenced code · 3 folded thinking · 4 tool card · 5 bash card · 6 compaction boundary · 7 image card from `show_image_to_user`. The pill and the composer/footer are not transcript history.

## Watching a turn arrive

A live turn and a replayed session paint the same block language, and the reader should not be able to tell which path produced what is on screen.

When the user sends, an optimistic `you` block appears at once and is replaced by the real message when Pi echoes it. The assistant block is created lazily by the first text delta, so a turn that only thinks or only calls tools leaves no empty labelled block. Streamed text is raw and monospaced while it arrives and becomes Markdown at `message_end`, in place, keeping its position and any open detail; deltas coalesce to one paint per animation frame.

A tool card appears when the call starts, streams its partial output, and gains duration, error state, exit code or an image at the end. A bash card is inserted optimistically, appends chunks and writes its meta line last. Compaction paints a progress row with elapsed time and phase, then adds a boundary and re-requests history; an aborted compaction leaves the transcript alone. Retries and extension failures are toasts, not blocks.

Two statuses shape the screen before any message exists. A new session paints `starting session…` with a disabled composer while the child boots; a stopped session reattaches from its file, so history is readable before the agent is live. On attach the hub's bounded window paints first and the child's delta appends only genuinely new entries.

<svg viewBox="0 0 360 800" width="100%" style="display:block;width:100%;max-width:360px;height:auto" role="img" aria-label="Decision flow: a Pi record arrives, duplicates are ignored, live deltas append while snapshot windows merge, truncated blocks fetch their full entry, running tools stream output, and scrolling decides follow versus jump">
  <rect x="8" y="4" width="344" height="792" rx="14" fill="#16141f" stroke="#322b45"/>
  <rect x="18" y="20" width="196" height="34" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="42" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">Pi record arrives</text>
  <line x1="116" y1="54" x2="116" y2="76" stroke="#6f6889"/>
  <polygon points="116,76 218,108 116,140 14,108" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="88" y="112" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">id known?</text>
  <line x1="218" y1="108" x2="252" y2="108" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="258" y="104" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">yes</text>
  <text x="258" y="117" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">drop the</text>
  <text x="258" y="129" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">duplicate</text>
  <line x1="116" y1="140" x2="116" y2="162" stroke="#6f6889"/>
  <text x="126" y="156" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">no</text>
  <rect x="18" y="162" width="196" height="34" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="184" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">which path is it?</text>
  <line x1="116" y1="196" x2="116" y2="216" stroke="#6f6889"/>
  <rect x="18" y="216" width="196" height="54" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="234" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">live delta → append now</text>
  <text x="28" y="249" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">snapshot / resume → merge</text>
  <text x="28" y="264" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">by id, fill above in chunks</text>
  <line x1="116" y1="270" x2="116" y2="292" stroke="#6f6889"/>
  <polygon points="116,292 218,324 116,356 14,324" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="80" y="328" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">text capped?</text>
  <line x1="218" y1="324" x2="252" y2="324" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="258" y="320" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">yes</text>
  <text x="258" y="333" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">“load full”</text>
  <text x="258" y="345" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">fetches one</text>
  <text x="258" y="357" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">entry, keeps</text>
  <text x="258" y="369" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">open details</text>
  <text x="258" y="381" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">and distance</text>
  <line x1="116" y1="356" x2="116" y2="388" stroke="#6f6889"/>
  <text x="126" y="376" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">no</text>
  <polygon points="116,388 218,420 116,452 14,420" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="76" y="424" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">tool running?</text>
  <line x1="218" y1="420" x2="252" y2="420" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="258" y="416" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">yes</text>
  <text x="258" y="429" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">stream the</text>
  <text x="258" y="441" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">partial into</text>
  <text x="258" y="453" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">the card</text>
  <line x1="116" y1="452" x2="116" y2="484" stroke="#6f6889"/>
  <text x="126" y="472" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">no</text>
  <rect x="18" y="484" width="196" height="34" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="506" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">block is painted</text>
  <line x1="116" y1="518" x2="116" y2="548" stroke="#6f6889"/>
  <polygon points="116,548 218,580 116,612 14,580" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="72" y="584" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">at the bottom?</text>
  <line x1="218" y1="580" x2="252" y2="580" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="258" y="576" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">yes</text>
  <text x="258" y="589" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">follow live</text>
  <text x="258" y="601" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">output</text>
  <line x1="116" y1="612" x2="116" y2="644" stroke="#6f6889"/>
  <text x="126" y="632" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">no</text>
  <rect x="18" y="644" width="196" height="34" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="666" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">show jump to newest</text>
  <line x1="116" y1="678" x2="116" y2="708" stroke="#6f6889"/>
  <rect x="18" y="708" width="196" height="46" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="726" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">tap it → stick = true,</text>
  <text x="28" y="741" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">smooth scroll to the end</text>
  <text x="18" y="780" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">The same decisions apply to a live delta and to a replayed snapshot.</text>
</svg>

## Thinking, live and finished

Pi streams reasoning as its own event type, and pixip treats it as part of reading rather than a hidden detail.

The turn starts with an `agent is thinking…` marker, a quiet pulsing row. As soon as thinking text exists it becomes a disclosure that streams the thought with the same ANSI rendering as the finished box; tapping toggles it, and the choice carries into the final `thinking` box above the answer. A message with no thinking keeps the plain, non-clickable marker and then loses it.

The marker's life is tied to the work: it hides when text or the final box replaces it, when a tool starts, and when the turn settles. A tool result can bring it back if the turn continues, so "thinking" never implies progress that is not happening.

On attach the hub sends the current thought as a derived frame and the client restores it collapsed; a same-tab reconnect keeps the reader's open state. Completed thoughts come from the snapshot, and a thought that was never persisted is gone after a reload — it was never part of the session.

## Tool cards and bash output

A tool card answers what ran, on what, did it work, how long. The name is warning-coloured, the argument summary is one ellipsized line picked from command, path, pattern, URL, query or file path, and the duration appears at the end. Output is converted from ANSI once, not per chunk, and scrolls inside a 60 % viewport cap so a huge log never takes over.

The bash card is the same idea with terminal semantics: escaped command, streamed output, and a meta line that is the authoritative end state. `!!` adds an `excluded` badge because its output stays in the session but out of the model context. Running and finished cards share one shell, so a reload repaints the same card.

Both cards participate in truncation. The attach window caps text, marks the entry and adds `load full`; opening a folded card on a truncated block also asks for the full entry. One request per entry is in flight, and the replacement keeps the card's open state and the reader's distance from the bottom. An unflushed entry returns a retryable notice.

<svg viewBox="0 0 360 470" width="100%" style="display:block;width:100%;max-width:360px;height:auto" role="img" aria-label="Wireframe comparing a collapsed transcript card with the same card expanded, showing summary and duration then output and a load full control">
  <rect x="4" y="4" width="172" height="462" rx="12" fill="#16141f" stroke="#322b45"/>
  <rect x="184" y="4" width="172" height="462" rx="12" fill="#16141f" stroke="#322b45"/>
  <text x="16" y="24" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">COLLAPSED · THE DEFAULT</text>
  <text x="196" y="24" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">EXPANDED · ON TAP</text>
  <text x="16" y="46" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">▸ thinking</text>
  <rect x="16" y="56" width="148" height="28" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="24" y="74" font-family="ui-monospace, monospace" font-size="8.5" fill="#e0af68">read</text>
  <text x="52" y="74" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">render.js</text>
  <text x="128" y="74" font-family="ui-monospace, monospace" font-size="8.5" fill="#6f6889">4ms</text>
  <rect x="16" y="94" width="148" height="28" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="24" y="112" font-family="ui-monospace, monospace" font-size="8.5" fill="#f7768e">bash</text>
  <text x="52" y="112" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">npm run check</text>
  <text x="16" y="146" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">name · one-line args · time</text>
  <text x="16" y="160" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">output stays folded</text>
  <text x="16" y="192" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">expanded thinking</text>
  <text x="16" y="208" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">weighs prepend vs append,</text>
  <text x="16" y="221" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">then holds the distance</text>
  <text x="16" y="238" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">from the bottom.</text>
  <text x="16" y="270" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">▾ thinking</text>
  <rect x="16" y="282" width="148" height="28" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="24" y="300" font-family="ui-monospace, monospace" font-size="8.5" fill="#e0af68">read</text>
  <text x="52" y="300" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">render.js</text>
  <text x="128" y="300" font-family="ui-monospace, monospace" font-size="8.5" fill="#6f6889">4ms</text>
  <text x="16" y="326" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">```</text>
  <text x="16" y="339" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">export function toolBlock(</text>
  <text x="16" y="352" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">  name, summary, output) {</text>
  <text x="16" y="365" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">…</text>
  <text x="16" y="380" font-family="ui-monospace, monospace" font-size="8.5" fill="#6f6889">scrolling output, 60dvh cap</text>
  <rect x="16" y="392" width="74" height="22" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="24" y="407" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">load full</text>
  <text x="16" y="434" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">only when the entry was</text>
  <text x="16" y="446" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">capped by the window</text>
  <rect x="196" y="46" width="148" height="28" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="204" y="64" font-family="ui-monospace, monospace" font-size="8.5" fill="#e0af68">bash</text>
  <text x="232" y="64" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">npm run check</text>
  <text x="196" y="90" font-family="ui-monospace, monospace" font-size="8.5" fill="#9ece6a">$</text>
  <text x="208" y="90" font-family="ui-monospace, monospace" font-size="8.5" fill="#e7e3f2">npm run check</text>
  <text x="196" y="106" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">typecheck… ok</text>
  <text x="196" y="120" font-family="ui-monospace, monospace" font-size="8.5" fill="#cfc9e0">214 tests passing</text>
  <text x="196" y="136" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">exit 0 · 42s · not truncated</text>
  <text x="196" y="166" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">streamed text is plain; the</text>
  <text x="196" y="178" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">final body gets ANSI colour</text>
  <rect x="196" y="196" width="148" height="34" rx="5" fill="#1d1a29" stroke="#f7768e"/>
  <text x="204" y="218" font-family="ui-monospace, monospace" font-size="8.5" fill="#f7768e">bash</text>
  <text x="232" y="218" font-family="ui-monospace, monospace" font-size="8.5" fill="#9b93b4">npm test -- daemon</text>
  <text x="196" y="246" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">exit 1 · error tints the card</text>
  <rect x="196" y="266" width="148" height="58" rx="5" fill="#1d1a29" stroke="#322b45"/>
  <text x="204" y="282" font-family="ui-monospace, monospace" font-size="8.5" fill="#e0af68">show_image_to_user</text>
  <rect x="204" y="290" width="40" height="24" rx="3" fill="#322b45"/>
  <text x="252" y="306" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">▸ output</text>
  <text x="196" y="344" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">image cards keep the picture</text>
  <text x="196" y="356" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">visible and fold the text</text>
  <text x="196" y="390" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Every card is a native details</text>
  <text x="196" y="402" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">element: the reader owns open</text>
  <text x="196" y="414" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">state, and a repaint restores it.</text>
</svg>

## Images in the transcript

An image the **user attached** is recorded in the message and rendered as a thumbnail; tapping it opens the image sheet. The text stays primary, so a screenshot with a one-line question still reads as a question.

An image the **agent shows** comes from exactly one tool, `show_image_to_user`. That card is not a folded result: the image strip is visible at once, with caption, size note and download link beside it, and the text output folds underneath. Only that tool is a deliberate display; an image inside any other result stays textual. Over 1 MB becomes a thumbnail with a download link; over 20 MB, a link only.

The sheet and attachment picker belong to other areas; this one owns how a recorded or displayed image reads.

## References inside messages

A sent user message can carry a `[pixip-ref=…]` tag. In the transcript it becomes an inert inline chip labelled with the referenced message or inbox subject; an unresolved tag degrades to literal text. Transcript chips are display-only — following a reference is a composer action — so tapping one never changes what the reader sees.

Each block also carries a corner action bar: insert the ref into the composer, fork from this point, or copy the ref with or without an excerpt. Tool and compaction actions live in the always-visible summary, because a closed disclosure hides appended children. The grammar and resolver belong to the refs area; here a block's ref comes from its entry id, or from `msg:<role>:<timestamp>` for a live block.

## Reading a long session

The transcript is append-only, and navigation follows from that.

**Scrolling** is native and inside `#log` only. The reader is pinned while within 80 px of the bottom, and live output follows the end; scrolling further up unpins them and new output no longer moves the view. A floating `↓ jump to newest` pill appears while unpinned; tapping it re-pins and glides to the end. It hides immediately and never covers the composer or the inline surface.

**Appending** is cheap and stable: a resume delta adds only unseen entries, deduplicated by id, holding the distance from the bottom for an unpinned reader. Only a replacement snapshot (after compaction or `/new`) drops old windows.

**Prepending** is the delicate case. `load earlier` sits above the oldest painted entry and asks for the preceding window of up to 200 entries; it is disabled and says `loading…` while in flight. Duplicates are dropped and `scrollHeight - scrollTop` is held constant so the reader's line does not jump. With no more history the button disappears.

**Windowing** keeps the first paint small: the newest entries up to about 24 KB paint synchronously, then the older part of the window fills in ~32 KB chunks above, holding the distance each time and always painting at least one entry. The newest message is on screen at once and the rest appears before the reader can scroll into a hole.

A **stopped session** reads from local files the same way: the bounded tail paints, then a wake or restart attaches the child and resumes with the delta.

<svg viewBox="0 0 360 580" width="100%" style="display:block;width:100%;max-width:360px;height:auto" role="img" aria-label="Wireframe of a long session: load earlier at the top, scrolled-up reader with the jump pill, and a pinned view where the pill is hidden">
  <rect x="8" y="4" width="344" height="572" rx="16" fill="#16141f" stroke="#322b45"/>
  <text x="22" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">long session</text>
  <text x="300" y="26" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">● ⋯</text>
  <line x1="8" y1="36" x2="352" y2="36" stroke="#322b45"/>
  <rect x="20" y="48" width="320" height="26" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="134" y="65" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">load earlier</text>
  <text x="20" y="98" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">↑ this button asks for the previous window</text>
  <rect x="20" y="112" width="2" height="40" fill="#7aa2f7"/>
  <text x="30" y="128" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">older message</text>
  <rect x="20" y="162" width="2" height="40" fill="#bb9af7"/>
  <text x="30" y="178" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">assistant answer</text>
  <rect x="20" y="212" width="2" height="40" fill="#7aa2f7"/>
  <text x="30" y="228" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">older message</text>
  <rect x="20" y="262" width="2" height="64" fill="#bb9af7"/>
  <text x="30" y="278" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">long answer, code block</text>
  <rect x="30" y="288" width="250" height="28" rx="4" fill="#241f33"/>
  <text x="38" y="306" font-family="ui-monospace, monospace" font-size="8.5" fill="#9ece6a">const window = planFirstPaint(…)</text>
  <rect x="216" y="344" width="124" height="26" rx="13" fill="#241f33" stroke="#322b45"/>
  <text x="226" y="361" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">↓ jump to newest</text>
  <line x1="20" y1="386" x2="340" y2="386" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="20" y="402" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">unpinned: new output lands below the fold,</text>
  <text x="20" y="414" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the reader keeps their line, the pill appears</text>
  <rect x="20" y="430" width="320" height="40" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="32" y="454" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">message pi…</text>
  <text x="20" y="490" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">pinned: pill hidden, output follows the end</text>
  <text x="20" y="508" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">prepend, full-entry replace and scale change</text>
  <text x="20" y="520" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">all hold the same distance from the bottom</text>
  <text x="20" y="548" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">One scroll container: #log. Nothing else scrolls it.</text>
</svg>

## Transcript readability controls

Text size is the only reading preference, and it is transcript-scoped.

The header's `…` menu holds `A−`, the current percentage and `A+`. There are seven stops — 50, 65, 80, 100, 115, 130 and 150 % — and the buttons disable at the ends. A tap steps one stop; a long press (about half a second) resets to 100 % without also firing the step, so the reset is reachable on a phone without a settings detour. On desktop, `Ctrl/Cmd` with `-`, `+` or `0` steps down, up or resets; plain keys are untouched so typing is unaffected.

The preference is device-local and persists. Only the transcript scales: the multiplier applies to `#log`, so the composer keeps 16 px (no iOS focus zoom) and the header, footer and tool-card chrome keep their sizes. A change holds the reader's position, so enlarging the text does not throw away the paragraph being read.

## Port-relevant technical notes

Port notes only; the rules above are the contract.

### Bounded transcript data

The client never receives full history. On attach the hub reads backwards from the JSONL tail until 200 entries or ~256 KB of raw lines, capping every text field at 8 KB and marking the entry `truncated: true`. Older history is `earlier {before}` → `history {entries, more}` in 200-entry windows; a resumed socket asks for `snapshot(since=<last entry id>)` and gets only the delta. The one full entry behind `load full` is `entry {id}` → `entry {entry | error}`, hard-capped at 8 MB; an unflushed entry returns an error the reader can retry. Dedupe is by `id` on append and prepend (`unseenEntries`, `prependWindow`); `mergeTail` keeps loaded windows unless the frame is a replacement.

### First paint and fill budgets

`transcriptWindow.js` is pure: `planFirstPaint` takes the newest entries up to 24 KB (at least one) and `planFillChunk` the previous ~32 KB. `renderTranscript` paints the first slice synchronously behind a token guard that cancels an in-flight fill, then fills above with `setTimeout(0)`.

### Live thinking buffer

`src/liveThinking.ts` keeps one buffer per attached session: text per content block, capped at 256 KB with the oldest trimmed first, cleared at `message_end`, `tool_execution_start` and `agent_settled`, never persisted. Thinking events carry a monotonic `seq` so deltas already folded into the derived frame are not applied twice on attach. After a snapshot the hub sends one `live_thinking {text, active, seq}` frame; `applyLiveThinkingFrame` preserves the tab's `expanded`. `thinkingStream.js` is the pure reducer, `transcriptView.js` the paint.

### Scroll and readability state

`transcriptScroll.js` is pure: `shouldStick` (80 px), `readingDistance` (client height when pinned, else `scrollHeight - scrollTop`) and `restoreScrollTop`; every content or layout change captures a distance first and restores it after, and paints coalesce in `requestAnimationFrame` while `state.stick` is true. `#log` is the only scroll container; sheets, surface and composer never scroll it. `transcriptScale.js` snaps to `STEPS`, maps missing or malformed storage to 100 %, and is applied as `--transcript-scale` on `documentElement` with `#log { font-size: calc(1rem * var(--transcript-scale, 1)) }`; the setting lives in `localStorage` under `pixip.transcriptScale`. The long-press reset is a 550 ms pointer timer that suppresses the click; keyboard uses `Ctrl/Cmd` + `-`/`+`/`0`.

### Rendering and safety

`render.js`, `markdown.js` and `transcriptWindow.js` are pure and shared with `node --test`; `transcript.js` and `transcriptView.js` are the DOM painters. Markdown renders once per message through a vendored `marked` build; raw HTML is escaped and links are limited to `http(s)`, `mailto` and in-page targets. ANSI converts once on the final result — SGR styles to spans, 16-colour/256/truecolour mapped, CSI/OSC dropped, and a progress line keeps only its last carriage-return segment.

## Boundaries

The composer owns sending, steering, queue chips, attachments and the 16 px input; sheets own the image viewer. Extension requests and A2UI panels belong to the inline surface, the ref grammar and jump behaviour to the refs area, and the footer stats to session controls. This document records how content reads once it is in the transcript, and no port verdicts.

## Sources

`src/client/transcript.js`, `transcriptView.js`, `thinkingStream.js`, `render.js`, `markdown.js`, `scroll.js`, `transcriptScroll.js`, `transcriptWindow.js`, `transcriptScale.js`, `transcript.css`, `src/liveThinking.ts`, `src/jsonl.ts`, `src/wire.ts`, `ARCHITECTURE.md` (data flow, live thinking, wire protocol), and `ui_work/UI_WIDGET_BREAKDOWN.html` (session widgets).

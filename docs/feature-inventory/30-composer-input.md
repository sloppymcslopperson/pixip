# Composer input

The composer is the one place a user puts something into a session: text, a slash command, a shell command or a file. The same row sends a prompt when the agent is idle and steers a running turn when it is busy, while the header's stop action detaches the agent and a queue strip shows messages Pi has not delivered. This area inventories the composer row, its menus, the queue chips and the command policy; transcript reading and ref grammar belong to other areas.

## Contents

- [User stories](#user-stories)
- [The composer row](#the-composer-row)
- [Prompting and steering](#prompting-and-steering)
- [Stopping, detaching and the queue](#stopping-detaching-and-the-queue)
- [Attachments](#attachments)
- [The command menu](#the-command-menu)
- [Slash commands the composer does not own](#slash-commands-the-composer-does-not-own)
- [Bash cards](#bash-cards)
- [Command policy](#command-policy)
- [Drafts and blocking panels](#drafts-and-blocking-panels)
- [References in the composer](#references-in-the-composer)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want to send, steer or stop without hunting for a modal.
- As a user, I want to attach a photo or file from my phone and see exactly what will be sent.
- As a user, I want to discover slash commands and still run a shell command when I know it.
- As a user, I want `!!` output in my transcript without becoming model context.
- As an admin, I want to restrict a session's commands and shell escapes without touching the agent's settings.
- As a user, I want my draft kept when an extension asks a question, and a clear refusal if I send over it.
- As a user, I want the pending queue visible and recoverable, not hidden.

## The composer row

The dock at the bottom of the session screen owns input: command menu, attachment menu, queue chips, composer row and footer. It shrinks the transcript and is hidden on the dashboard; a new session shows the row disabled until the child is ready.

The row has three controls: `+`, the input and send. The input is contenteditable wearing the textarea contract: placeholder `message pi…`, a minimum tap-target height, and autosize up to 40 % of the viewport before it scrolls. Its 16 px font keeps iOS Safari from zooming on focus, and the placeholder is a class so tapping the blank field still focuses it.

Send is one arrow with no mode switch. It is disabled while the session is starting, stopped, errored, restarting or compacting, while an attachment is uploading or failed, and while text is empty with no attachment. On a fine pointer Enter submits unless Shift is held (newline); on a coarse pointer Enter is a newline and the button submits. Compositions are never interrupted, and pasted text lands at the caret rather than letting clipboard HTML in.

## Prompting and steering

The user does not choose "prompt" or "steer"; session state decides. When idle, submitting text starts a normal turn. When busy, the same text is sent as a steering message, which Pi adds to the running turn. The interface stays the same: same placeholder, same arrow, same row, so the header dot and footer are what explain why a message will steer rather than start.

Plain text gets an optimistic `you` block built from the same text and images the wire will carry, then replaced by Pi's echo. A slash command gets no optimistic echo: an extension command may consume the prompt, and a template or skill only produces a message when Pi expands it.

An empty send does nothing. Plain text and bash commands have their outer whitespace trimmed; a passthrough slash command keeps only that trim, so arguments and `/skill:name …` reach Pi verbatim.

## Stopping, detaching and the queue

The header's `stop` appears in an open session. It detaches the Pi child: the transcript and JSONL remain, the session becomes stopped, and the composer disables until the user leaves or wakes it. It ends the run rather than aborting one turn; there is no abort-and-continue button.

While busy, messages can sit in Pi's steering or follow-up queue. The strip above the composer shows a count, a clear `×`, and one chip per queued text; tapping a chip expands it in place. The chips are not drafts, but what Pi reports as pending.

Clearing asks Pi to remove both lists. The hub returns the removed texts, and the client puts them back as unsent text after any existing draft; nothing is re-sent. A chip only disappears when Pi says it is gone, so the display cannot drift ahead of the child. The composer has no follow-up selector, though follow-up entries can appear from Pi or another client, and clear treats both lists the same.

## Attachments

One attachment may be pending at a time. The `+` menu offers **Photo or camera**, an image picker with `accept="image/*"` and no capture attribute so a phone offers camera and library, and **Choose file**, the generic picker. Clipboard paste uses the same decision: a clipboard file is an attachment, otherwise the text is inserted. A second choice replaces the first.

The pending card shows what will go: for an image, thumbnail, filename, size and dimensions; for a file, icon, name, size and `uploading…` or `ready`. Every card has a remove `×`; busy and failed states reuse it with a status line and error border.

A source image over 20 MB is refused before decoding. Otherwise the browser decodes it, scales the longest edge to at most 1600 px without upscaling, paints it on white, and tries JPEG then PNG. An encoded image over 8 MB becomes an error rather than a payload. The base64 image travels as Pi `ImageContent` and reappears as a user-block thumbnail.

Non-image files use an upload route with a 100 MB cap: the browser POSTs raw bytes, and the hub writes a safe, unique name under the per-session folder. The prompt gets `Attached file: <absolute path>` after the text, or as the whole prompt for an attachment-only send. Uploads survive stop and reattach and are cleared on `/new`, archive and delete.

Plain prompts and passthrough slash commands carry the attachment. It blocks builtins, TUI-only notices and `!`/`!!` with a notice such as `remove or send the attachment before running a bash command`. An undecodable image from the generic picker falls back to the file-upload path.

## The command menu

Typing `/` at the start of a bare command opens the menu. It stays open only while the cursor is inside the command name; a space ends command position, so arguments do not reopen it. Focusing can reopen it, blur closes it, and tapping a row uses pointerdown so the field keeps focus and the keyboard stays up.

Rows show name, argument hint, summary and a dim `TUI-only` tag. Filtering is a case-insensitive substring match on name and summary, ranked by name prefix, other name matches, then summary matches, each alphabetical; there is no fuzzy scoring. Arrows move, Enter and Tab choose, Escape closes, a tap chooses.

Choosing a normal row inserts `/name` plus a space only when it takes arguments, caret at the end. A TUI-only row inserts `/name` and runs its local notice immediately.

The catalog combines the static builtin and TUI-only lists with live `get_commands`, covering extension commands, prompt templates and skills. Static entries win collisions, so menu and classifier cannot disagree; the live list is cached per attach. Denied commands disappear from the menu; TUI-only commands remain unless denied.

## Slash commands the composer does not own

Every slash line not in the static catalog is forwarded to Pi as a prompt: `/fit`, `/skill:review`, a template, even an unknown `/thing`. The composer keeps the line verbatim and lets Pi decide what it means. That passthrough is why slash input while busy uses `prompt` with a steering behavior rather than a plain steer: a steering RPC would queue the text instead of letting an extension command execute. An attachment rides the same path.

Commands the TUI has but pixip has no RPC surface for (`/login`, `/settings`, `/mcp`, `/hotkeys` and siblings) are a local notice only. The text never reaches the model, and the composer clears after the notice. A recognised but unwired builtin behaves the same with a `not wired yet` notice. A bare `/` is not a command and never sends; it only opens the menu.

## Bash cards

A line starting with `!` or `!!` is a shell escape, not a prompt. The check is on the trimmed line, so leading spaces still count. The command after the bang is trimmed, an escape with no command is a no-op that keeps the text, and one bash may run per session at a time. A second attempt toasts and keeps the text.

A valid line paints a card immediately with `$`, the command and `running…`; output streams into it. The final result replaces the card: output, exit code, cancellation, truncation and full-output path all come from the terminal frame. A non-zero exit or cancellation tints the card as an error.

`!!` is the same card with an `excluded` badge, because its output is recorded in the session but kept out of model context. There is no in-card abort control: a long-running bash can only be ended by stopping the session, which detaches the child. This is a known parity gap, not a hidden gesture.

## Command policy

Policy is per session and restrict-only. Three layers merge, most general first: `pixip.json` in the data directory, `.pixip.json` in the session's cwd, and the CLI flags `--allow-command`, `--deny-command` and `--no-bash`. A specific layer narrows but never widens.

The shape is a `commands` object with `allow`, `deny` and `bash`, using bare names (`compact`, not `/compact`). Deny always wins. A non-empty allow list restricts everything outside it; an empty list means no allow restriction, not "allow nothing". Allow lists intersect, deny lists union, and `bash` is an AND, so one `false` disables `!` and `!!` everywhere.

A denied command produces a local notice and clears the composer without reaching the model; the menu hides it, so a user cannot discover it only to be refused. A malformed file fails the attach with its path. The policy is resolved at attach and re-resolved by a soft refresh, so editing a file does not change a running turn.

`bash: false` blocks both escapes; it does not disable the agent's own tools or Pi's internal shell access, only this composer hatch.

## Drafts and blocking panels

A draft lives in the editor, not a global store. Switching to another session and back to a cached one restores its input with its transcript; a fresh session clears it. It is not persisted across a full page reload unless cached in memory for that page.

When an extension raises a blocking request, the inline surface takes the space between transcript and composer and the composer is hidden. The typed value is untouched, surface fields keep their per-request drafts, and hide/restore is idempotent across nested requests. Submitting while a surface is open is refused with `answer or cancel the request first` even by a keyboard path. Compaction is gentler: input and attach disable, the draft stays, and the progress row says `draft kept` when text is present.

A reference inserted from the transcript while the composer is hidden is copied to the clipboard instead.

## References in the composer

A `[pixip-ref=…]` tag typed or pasted into the composer becomes an inline chip. The chip is atomic: click or Enter/Space opens it, and a second activation jumps to the referenced message or inbox item. While open, a small `×` removes it. Deleting around the chip removes it as a unit, and the prompt serialises back to the raw tag, so the wire, a draft and the CLI see the same bytes.

Inserting a reference from a transcript block or inbox card appends its tag to the draft and leaves the caret at the end. Unresolved tags render as a dashed, faint `unresolved` pill, but the text is never discarded. The grammar and resolver belong to references; the composer owns insertion, serialisation and removal.

<svg viewBox="0 0 760 316" width="100%" style="display:block;width:100%;max-width:760px;height:auto" role="img" aria-label="Four composer states: idle, streaming with queue chips, pending attachment preview, and the slash command menu">
  <rect x="4" y="4" width="752" height="308" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">THE SAME DOCK · FOUR STATES</text>
  <rect x="16" y="38" width="174" height="258" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">1 · IDLE</text>
  <rect x="26" y="72" width="154" height="52" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="34" y="94" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">message pi…</text>
  <text x="34" y="110" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">16 px · autosize</text>
  <rect x="26" y="136" width="34" height="30" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="36" y="156" font-family="ui-monospace, monospace" font-size="16" fill="#9b93b4">+</text>
  <rect x="68" y="136" width="78" height="30" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="76" y="155" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">typed text</text>
  <rect x="154" y="136" width="26" height="30" rx="8" fill="#7aa2f7"/>
  <text x="162" y="156" font-family="ui-monospace, monospace" font-size="14" fill="#1a1626">↑</text>
  <text x="26" y="188" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Enter sends on a fine pointer;</text>
  <text x="26" y="200" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Shift+Enter is a newline. On a</text>
  <text x="26" y="212" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">coarse pointer Enter is a</text>
  <text x="26" y="224" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">newline and ↑ still sends.</text>
  <text x="26" y="250" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">send disabled when empty</text>
  <text x="26" y="266" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">and no attachment is ready</text>

  <rect x="198" y="38" width="174" height="258" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="208" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">2 · STREAMING + QUEUE</text>
  <rect x="208" y="70" width="154" height="58" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="216" y="86" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">2 queued</text>
  <text x="344" y="86" font-family="ui-monospace, monospace" font-size="11" fill="#9b93b4">×</text>
  <rect x="216" y="94" width="66" height="16" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="222" y="105" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">fix the test</text>
  <rect x="288" y="94" width="52" height="16" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="294" y="105" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">and lint</text>
  <text x="216" y="121" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">tap a chip to expand it · clear restores</text>
  <rect x="208" y="140" width="154" height="42" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="216" y="160" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">steer the running turn</text>
  <text x="216" y="173" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">same row · no mode switch</text>
  <rect x="208" y="190" width="34" height="30" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="218" y="210" font-family="ui-monospace, monospace" font-size="16" fill="#9b93b4">+</text>
  <rect x="250" y="190" width="78" height="30" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="260" y="209" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">steer text</text>
  <rect x="336" y="190" width="26" height="30" rx="8" fill="#7aa2f7"/>
  <text x="344" y="210" font-family="ui-monospace, monospace" font-size="14" fill="#1a1626">↑</text>
  <text x="208" y="246" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">queue_update replaces the strip;</text>
  <text x="208" y="258" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the optimistic you-block is removed</text>
  <text x="208" y="270" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">while a message is still pending.</text>

  <rect x="380" y="38" width="174" height="258" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="390" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">3 · ATTACHMENT READY</text>
  <rect x="390" y="68" width="154" height="50" rx="8" fill="#16141f" stroke="#322b45"/>
  <rect x="398" y="76" width="34" height="34" rx="5" fill="#322b45"/>
  <text x="404" y="97" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">IMG</text>
  <text x="440" y="86" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">photo.jpg</text>
  <text x="440" y="99" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">820 KB · 1600×900</text>
  <text x="526" y="97" font-family="ui-monospace, monospace" font-size="12" fill="#9b93b4">×</text>
  <rect x="390" y="128" width="154" height="42" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="398" y="148" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">what is wrong here?</text>
  <text x="398" y="161" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">image rides the prompt</text>
  <rect x="390" y="178" width="34" height="30" rx="8" fill="#241f33" stroke="#322b45"/>
  <text x="400" y="198" font-family="ui-monospace, monospace" font-size="16" fill="#9b93b4">+</text>
  <rect x="432" y="178" width="78" height="30" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="440" y="197" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">one at a time</text>
  <rect x="518" y="178" width="26" height="30" rx="8" fill="#7aa2f7"/>
  <text x="526" y="198" font-family="ui-monospace, monospace" font-size="14" fill="#1a1626">↑</text>
  <text x="390" y="230" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Picking another replaces it.</text>
  <text x="390" y="242" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Builtins and bash ask you to</text>
  <text x="390" y="254" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">remove or send it first; plain</text>
  <text x="390" y="266" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">prompts and /commands carry it.</text>

  <rect x="562" y="38" width="174" height="258" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="572" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">4 · COMMAND MENU</text>
  <rect x="572" y="68" width="154" height="104" rx="8" fill="#16141f" stroke="#322b45"/>
  <rect x="580" y="76" width="138" height="20" rx="4" fill="#241f33"/>
  <text x="586" y="90" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">/compact</text>
  <text x="652" y="90" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">[instructions]</text>
  <text x="586" y="108" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">/copy  copy the last answer</text>
  <text x="586" y="124" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">/clone  duplicate the branch</text>
  <text x="586" y="140" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">/login  OAuth login</text>
  <text x="638" y="140" font-family="ui-monospace, monospace" font-size="6" fill="#6f6889">TUI-only</text>
  <text x="586" y="156" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">/fit  extension command</text>
  <rect x="572" y="182" width="154" height="42" rx="8" fill="#16141f" stroke="#322b45"/>
  <text x="580" y="202" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">/com</text>
  <text x="580" y="215" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">filter by name, then summary</text>
  <text x="572" y="240" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">arrows move · Enter/Tab insert</text>
  <text x="572" y="252" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Escape closes · a tap inserts</text>
  <text x="572" y="264" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">a space ends command position</text>
  <text x="572" y="284" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">denied commands never appear</text>
</svg>

1 idle · 2 busy steering with pending queue · 3 a ready image attachment · 4 the filtered slash menu. The footer is unchanged in all four states.

<svg viewBox="0 0 720 552" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-label="Decision flow: a submitted line or an attachment is classified, checked against policy, then sent as a prompt, a steer, a command or a bash card; a denial returns a local notice">
  <rect x="4" y="4" width="712" height="544" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">ONE SUBMIT, FIVE OUTCOMES</text>

  <rect x="20" y="42" width="224" height="32" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="30" y="62" font-family="ui-monospace, monospace" font-size="10" fill="#e7e3f2">submit line or press ↑</text>
  <line x1="132" y1="74" x2="132" y2="90" stroke="#6f6889"/>
  <polygon points="132,90 250,112 132,134 14,112" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="88" y="116" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">what is it?</text>

  <line x1="132" y1="134" x2="76" y2="164" stroke="#6f6889"/>
  <rect x="20" y="164" width="112" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="182" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">! / !! command</text>
  <text x="28" y="196" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">one at a time</text>
  <line x1="76" y1="210" x2="76" y2="230" stroke="#6f6889"/>
  <rect x="20" y="230" width="112" height="34" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="251" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">Pi RPC bash card</text>

  <line x1="154" y1="134" x2="154" y2="164" stroke="#6f6889"/>
  <rect x="140" y="164" width="112" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="148" y="182" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">/builtin</text>
  <text x="148" y="196" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">compact, model…</text>
  <line x1="196" y1="210" x2="196" y2="230" stroke="#6f6889"/>
  <rect x="140" y="230" width="112" height="34" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="148" y="251" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">local handler</text>

  <line x1="196" y1="134" x2="286" y2="164" stroke="#6f6889"/>
  <rect x="260" y="164" width="112" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="268" y="182" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">/other</text>
  <text x="268" y="196" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">fit, skill, template</text>
  <line x1="316" y1="210" x2="316" y2="230" stroke="#6f6889"/>
  <rect x="260" y="230" width="112" height="34" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="268" y="251" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">prompt + steer if busy</text>

  <line x1="250" y1="122" x2="404" y2="122" stroke="#6f6889"/>
  <rect x="404" y="96" width="112" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="412" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">plain text</text>
  <text x="412" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">busy?</text>
  <rect x="532" y="96" width="112" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="540" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">idle → prompt</text>
  <text x="540" y="128" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">busy → steer</text>
  <line x1="516" y1="122" x2="532" y2="122" stroke="#6f6889"/>

  <line x1="20" y1="290" x2="700" y2="290" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="20" y="312" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">POLICY GATE · BEFORE ANY OF THEM</text>
  <polygon points="132,326 250,348 132,370 14,348" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="92" y="352" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">allowed?</text>
  <line x1="250" y1="348" x2="286" y2="348" stroke="#6f6889"/>
  <rect x="286" y="326" width="150" height="44" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="294" y="344" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">yes → the outcome</text>
  <text x="294" y="358" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">bash still needs bash: true</text>
  <line x1="132" y1="370" x2="132" y2="392" stroke="#6f6889"/>
  <rect x="20" y="392" width="230" height="44" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="28" y="410" font-family="ui-monospace, monospace" font-size="9" fill="#f7768e">no → local notice</text>
  <text x="28" y="424" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">"blocked by the command policy" · input cleared</text>

  <line x1="20" y1="456" x2="700" y2="456" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="20" y="478" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">ATTACH FIRST, THEN SUBMIT</text>
  <rect x="20" y="490" width="112" height="34" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="28" y="511" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">+ or paste</text>
  <line x1="132" y1="507" x2="152" y2="507" stroke="#6f6889"/>
  <polygon points="152,486 254,507 152,528 50,507" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="122" y="511" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">image?</text>
  <line x1="254" y1="494" x2="280" y2="494" stroke="#6f6889"/>
  <rect x="280" y="478" width="170" height="34" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="288" y="499" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">decode · 1600 px · JPEG/PNG</text>
  <line x1="450" y1="494" x2="470" y2="494" stroke="#6f6889"/>
  <rect x="470" y="478" width="216" height="34" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="478" y="499" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">ImageContent rides prompt / steer</text>
  <line x1="254" y1="520" x2="280" y2="520" stroke="#6f6889"/>
  <rect x="280" y="536" width="170" height="28" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="288" y="554" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">upload · 100 MB</text>
  <line x1="450" y1="550" x2="470" y2="550" stroke="#6f6889"/>
  <rect x="470" y="536" width="216" height="28" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="478" y="554" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">path appended · never over the socket</text>
</svg>

<svg viewBox="0 0 720 248" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-label="Four bash card states: running, successful, excluded from context, and failed or truncated">
  <rect x="4" y="4" width="712" height="240" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">BASH CARD · ONE CARD, FOUR END STATES</text>
  <rect x="18" y="40" width="162" height="188" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">$</text>
  <text x="40" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">npm run check</text>
  <text x="28" y="80" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">typecheck… ok</text>
  <text x="28" y="94" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">tests… 214 passing</text>
  <text x="28" y="116" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">running…</text>
  <text x="28" y="146" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">optimistic card painted</text>
  <text x="28" y="158" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">on submit; chunks append</text>
  <text x="28" y="170" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">as bash_execution_update</text>
  <text x="28" y="182" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">events arrive.</text>

  <rect x="192" y="40" width="162" height="188" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="202" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">$</text>
  <text x="214" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">npm run check</text>
  <text x="202" y="80" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">typecheck… ok</text>
  <text x="202" y="94" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">tests… 214 passing</text>
  <text x="202" y="116" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">exit 0 · 42s</text>
  <text x="202" y="146" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">terminal frame replaces</text>
  <text x="202" y="158" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">the running card; the</text>
  <text x="202" y="170" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">output, exit code and</text>
  <text x="202" y="182" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">duration are final.</text>

  <rect x="366" y="40" width="162" height="188" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="376" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">$</text>
  <text x="388" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">git status</text>
  <rect x="470" y="49" width="46" height="14" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="477" y="59" font-family="ui-monospace, monospace" font-size="6" fill="#e0af68">excluded</text>
  <text x="376" y="80" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">On branch main</text>
  <text x="376" y="94" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">nothing to commit</text>
  <text x="376" y="116" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">exit 0</text>
  <text x="376" y="146" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">!! is the same card</text>
  <text x="376" y="158" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">with a badge: output</text>
  <text x="376" y="170" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">stays in the transcript,</text>
  <text x="376" y="182" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">not in model context.</text>

  <rect x="540" y="40" width="162" height="188" rx="9" fill="#1d1a29" stroke="#f7768e"/>
  <text x="550" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">$</text>
  <text x="562" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">npm test -- daemon</text>
  <text x="550" y="80" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">1 failing</text>
  <text x="550" y="94" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">timed out</text>
  <text x="550" y="116" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">exit 1 · truncated</text>
  <text x="550" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">full output: /tmp/…</text>
  <text x="550" y="152" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">a non-zero exit or</text>
  <text x="550" y="164" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">cancellation tints the</text>
  <text x="550" y="176" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">card; truncation keeps</text>
  <text x="550" y="188" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">the full-output path.</text>
</svg>

## Port-relevant technical notes

Port notes only; the user-facing rules above are the contract.

### Prompt, steer and stop mapping

A plain send emits `prompt` when idle and `steer` when busy; the hub maps `steer` to Pi's `prompt` with `streamingBehavior: "steer"`. RPC `steer` is not used because it only queues and does not execute extension commands. A slash command always uses `prompt`, adding the steering behavior while busy. A failed prompt response is advisory, because extension handlers can outlive timeouts. `stop` closes the child after persisting the name and status; the JSONL stays authoritative. The `abort` frame exists but has no composer control.

### Queue and clear

`queue_update` is a verbatim event carrying the complete `steering` and `followUp` arrays; the client replaces rather than appends, filters non-strings, renders steering first, and removes the optimistic block while anything is pending. `clear_queue` clears both lists and returns them; the hub answers with a `queue` frame and the client restores the texts unsent.

### Bash path

The client generates the id, paints the card, and sends `bash`. Pi repeats that id on every `bash_execution_update`, forwarded verbatim; the client appends each delta. The terminal frame carries output, exit code, cancellation, truncation and full-output path and replaces the optimistic card. The hub allows one bash per session, exempts it from the 20 s timeout, and always uses Pi's RPC bash so cwd and environment apply.

### Attachment handoff

`fitImage` plans the downscale, `IMAGE_ENCODE_ATTEMPTS` prefers JPEG then PNG, and `optimisticContent` matches the echoed message. Images are base64 `ImageContent`; the hub checks MIME type, base64 length and decoded size and allows one. Files bypass the socket through the upload route; the prompt receives the absolute path.

### Policy resolution

`src/client/commands.js` owns the merge and checks; `src/commands.ts` owns disk access and validation. The hub resolves at attach, caches on the live session, serves a `policy` frame, and re-resolves on soft reload. A parse error fails the attach, and the same merge feeds the menu and submit check.

### Client-only pieces

`composerEditor.js` installs a textarea-compatible facade over the contenteditable field and serialises chips back to raw tags. `attachments.js`, `commands.js`, `queue.js` and `surfaceQueue.js` are DOM-free and tested with `node --test`; `composerAttachments.js`, `menu.js`, `menuView.js`, `queueView.js` and `sendState.js` are the DOM seams.

## Boundaries

This area owns how input is composed, classified, attached, queued and refused. Transcript reading, block rendering and the image viewer belong to transcript; ref grammar and jump to references; extension requests and the inline surface to extension UI; stop/restart/reload to session control and daemon/CLI. Recorded user-message thumbnails are transcript-owned.

## Sources

`src/client/composer.js`, `composerInput.js`, `composerEditor.js`, `composerAttachments.js`, `composerBash.js`, `attachments.js`, `commands.js`, `menu.js`, `menuView.js`, `queue.js`, `queueView.js`, `sendState.js`, `surfaceQueue.js`, `composer.css`, `src/attachments.ts`, `src/commands.ts`, `src/hubControl.ts`, `src/hubLive.ts`, `src/hubSession.ts`, `src/server.ts`, `src/wire.ts`, `ARCHITECTURE.md` (composer commands, attachments, wire protocol), `docs/TUI-parity.md`, and `ui_work/UI_WIDGET_BREAKDOWN.html` (composer and dock widgets).

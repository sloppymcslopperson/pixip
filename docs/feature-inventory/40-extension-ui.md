# 40 · Extension requests and the inline surface

An extension's question reaches the phone in one of three shapes: a blocking
dialog in a docked inline surface, a short toast for notifications, or a rendered
panel (including A2UI) in that same surface. The surface never covers the
transcript, never steals an unsent draft, and can only show one question at a
time. The hub owns the clock: a question that goes unanswered is cancelled in Pi,
offered again as a read-only re-ask card, and shown as `waiting for you` on the
session and the dashboard until it is dealt with.

## Contents

- [What people want from a request](#what-people-want-from-a-request)
- [Where a request appears](#where-a-request-appears): notify, dialogs, panels, add-on output
- [The four blocking dialogs](#the-four-blocking-dialogs): select, confirm, input, editor
- [The inline surface](#the-inline-surface): expanded, collapsed, composer, one at a time, Replace, fallback
- [A2UI panels](#a2ui-panels): payload, lazy renderer, title suppression, failures
- [Leaving and coming back](#leaving-and-coming-back): replay, drafts, parked sessions
- [Timeouts, more time and re-ask](#timeouts-more-time-and-re-ask)
- [Wireframes](#wireframes): surface states, A2UI and recovery, decision flow
- [Technical notes (port-relevant)](#technical-notes-port-relevant)

## What people want from a request

- Answer an extension's question from the phone without losing the place in the
  transcript or the text already typed in the composer.
- Cancel a question that is not wanted.
- Close the browser mid-question and find the question still there on return.
- Have a timed-out question offered again instead of silently disappearing.
- Trust an A2UI form to behave as the extension intended, because the hub only
  carries the payload.

## Where a request appears

An extension request always arrives as a Pi event (`extension_ui_request`), and
the client routes on its `method`:

| Shape | Methods | Where it goes | Blocks the agent |
| --- | --- | --- | --- |
| Toast | `notify` | A toast over the composer, 3.2 s | No |
| Inline surface | `select`, `confirm`, `input`, `editor` | Docked between transcript and composer | Yes |
| Inline surface | `panel` | Same slot, rendered by a panel renderer | Yes |
| Footer output | `setStatus`, `setWidget` | Session footer widgets | No |

`notify` is fire and forget: short messages toast, and a long or multi-line
message (over 180 characters, or any newline) opens a titled `notice` sheet
instead, so a 2 KB `/fit help` dump is not compressed into a toast that vanishes
while you read it. Status and widget requests repaint the footer and are covered
by **80 · Session control** and **50 · Bundled extensions**.

An extension question is never a modal sheet. App-owned sheets (settings,
directory browse, worktree creation, image view, a long notice) stay modal;
extension dialogs use the inline surface because blocking on a dialog must not
hide the conversation the user is answering from. A method the client does not
recognise is ignored rather than guessed at.

## The four blocking dialogs

Each dialog is one card: a title, a status line, a body, and stacked full-width
action buttons that wrap long text instead of truncating it. Every dialog can be
collapsed or refused from the same frame, without leaving the session.

- **select** — one button per option, in the order the extension supplied them,
  plus `cancel`. The chosen option is sent back as-is, not as an index.
- **confirm** — `yes` and `no`, renamed from the request's `yesLabel`/`noLabel`
  when the extension supplied its own wording, plus `cancel`. The answer is a
  boolean, so a dismissal is distinguishable from a `no`.
- **input** — a single-line field prefilled from `value`, `initialValue` or
  `prefill`, the message as hint, and `send`/`cancel`; Enter sends, Escape
  cancels.
- **editor** — the same as a textarea sized to 4–12 rows from the prefill; Enter
  submits and Shift+Enter inserts a newline.

The surface does not validate. If the extension needs a non-empty answer it
validates in Pi and can ask again; the phone only guarantees that what was typed
travels back unchanged, and that cancel is a cancellation (`cancelled: true`)
rather than an empty string or a `false`. Answers are exactly-once: the request
leaves the queue before the response is sent, so a double tap cannot answer
twice.

## The inline surface

The surface is a dedicated flex slot between `#log` and the composer. It is
content-sized, capped at almost the session height (leaving a thin sliver of
transcript visible), scrolls internally when a panel is taller than that, and
centres itself at the same 104-character reading width as the transcript. It is
not fixed-positioned, so `#log` stays the only transcript scroll container and
the jump-to-latest pill sits above the surface instead of over its buttons.

### Expanded and collapsed

The surface opens expanded. The header shows the request title, a status line
(`select · waiting for you`, or `panel · 2 waiting` when others are queued), a
`collapse`/`expand` toggle and a `×` that cancels the request. Collapsing keeps
the header and hides the body and the Replace banner, so a tall A2UI form can be
folded away to read the transcript and unfolded with its state intact. The choice
survives repaints but resets when a new request becomes active, because a newly
arrived question should be visible.

### The composer and the draft

The composer is hidden for every blocking request, including re-ask and
more-time cards, and restored to its previous visibility when the last request
settles. It is hidden rather than cleared, so a half-typed prompt survives the
whole exchange. `submit` refuses while the surface is up with the toast `answer or
cancel the request first`, so a queued prompt cannot be mistaken for an answer. An
attachment in flight is neither sent nor dropped.

Panel drafts are saved by their renderer: every input and change event snapshots
the data model into `sessionStorage` under the request id, so a collapsed,
re-attached or re-issued panel comes back with the same selections and text. The
plain `input` and `editor` fields keep their text while the surface stays mounted
(collapsing, or a queued second request) but are not snapshotted, so a remounted
field returns to its initial value.

### One request at a time, and the Replace banner

The queue holds one active request and any number behind it. A repeated frame for
an id already active or queued is ignored, which makes replay after a reconnect
idempotent. When more requests wait, a warning-coloured banner appears under the
header reading `1 new request waiting` or `N new requests waiting`, with a
**Replace** button: replacing cancels the active request and promotes the queued
one immediately. Answers and cancels always settle the active request, so there is
no way to answer a request the user cannot see.

### Fallback instead of a blank surface

A panel whose mode has no registered renderer, or whose renderer throws while
mounting, shows a dashed fallback card: `This panel cannot be shown yet`, the mode
name, the request id, and a `cancel request` button. The user always has a way
out; nothing fails to a blank body with no cancel.

## A2UI panels

An A2UI panel is a `panel` request whose payload is opaque to the hub:
`{messages, surfaceId?, title?, mode: "a2ui"}`. `messages` is the ordered A2UI
v1.0 message array, the surface id comes from the payload or the first
`createSurface` message, and the title becomes the surface header.

The renderer is a vendored, prebuilt A2UI v1.0 bundle imported lazily on the
first A2UI panel. Until the import resolves the body shows `Loading panel…`, so
page load never pays for the renderer. Once loaded, the adapter:

- removes an in-panel `Text` component that merely repeats the header title;
- checks every component type against the Basic catalog before mounting, and
  falls back when a component is missing;
- builds a surface from the messages and answers catalog actions as a JSON string
  with `name`, `surfaceId`, `sourceComponentId`, `timestamp` and a resolved
  `context`; an explicit cancel sends `cancelled: true` instead;
- keeps its palette on the wrapper with theme variables, so shadow-root internals
  follow the light/dark theme, and pins 16 px inputs so iOS does not zoom.

A2UI is data, not code. Only catalog components render, strings are never
injected as HTML, media URLs go through the catalog's sanitizer, and a failed
processor or deleted surface produces a readable card (`This panel could not be
rendered`, `This panel was closed`) rather than partial UI. The hub forwards the
payload and returns whatever the client sends; the extension parses the action.

A developer can see the path in dev mode: `?panel=fixture`, `?panel=long`,
`?panel=tabs` and `?panel=questionnaire` open a fixture as a normal request.

## Leaving and coming back

The hub keeps the pending request, not the browser. Every blocking request is
cached on the live session as its original frame. When a client attaches, the hub
subscribes it before asking for the transcript snapshot and replays the cached
frames immediately, so a reopened tab gets its dialog back before the transcript
paints; a reconnect with a cursor gets the same treatment without duplicates.
Only unanswered requests replay: answering clears the cache entry, so an answered
panel never comes back.

Switching sessions in the same tab parks the surface state with the session cache
(active request, queue, collapsed flag) and restores it on return, remounting a
panel from its saved draft. Leaving the session or returning to the dashboard
resets the surface without sending anything, so navigation never answers a
question by accident. Requests that timed out while the browser was away are not
replayed as dialogs; they arrive as re-ask cards after the snapshot.

## Timeouts, more time and re-ask

The hub owns the clock. The client never counts down and the extension never
negotiates a deadline.

- With no browser attached, a request waits 5 hours
  (`--pending-ui-timeout-ms`).
- With a browser attached it waits 10 hours
  (`--pending-ui-open-timeout-ms`), so a full work day fits.
- `0` disables the timeout for that case.

Attaching a browser re-arms every pending timer to the attached value; detaching
restores the detached value. When a request reaches its timeout with a browser
attached, the hub asks the user instead of expiring it: the surface becomes a
`Need more time?` card with **more time** (reset the clock, keep the draft) and
**shelve it** (expire now). If nobody answers that card for two minutes
(`--pending-ui-more-time-ms`), it shelves itself. With nobody attached the
request expires directly, because there is no one to ask.

Expiring is not a silent loss:

1. The hub drops the request from its cache and broadcasts `ui_timeout`, so the
   client removes the surface card without sending an answer.
2. It sends `cancelled: true` back to Pi, so the extension call resolves and the
   agent turn settles instead of hanging forever.
3. It asks the agent, in the conversation, whether the request should be offered
   again on resume, and waits 60 seconds for a YES/NO reply (unclear counts as
   yes).
4. On yes it writes the raw request, timeout and attached flag to
   `<data-dir>/pending-ui/<logical-id>.json` and pushes a `reasks` frame. On no it
   records nothing.

A recorded request is shown as a read-only re-ask card: `“Choose a branch” timed
out after 10 hours with no answer. Ask the agent to show it again?` The card has
**re-ask** and **dismiss**. Re-ask prompts the agent with the original raw request
and the instruction to re-issue the same call with the same arguments; the record
is removed and the reissued panel inherits the shelf-time draft. Dismiss removes
the record without prompting. Either way the card cannot be replayed twice.

A live pending request, or any recorded re-ask for the session, sets
`awaitingUser`. The session header then reads `waiting for you` with a pink-red
dot, and the dashboard row shows the same dot; precedence is `error`, then
`waiting`, then `idle`/`busy`/`stopped`/`starting`. A stopped session can still
read as waiting, because the recorded request outlives the child process. Both
the status frame and the dashboard list refresh when the flag changes.

## Wireframes

### Surface states

```svg
<svg viewBox="0 0 720 440" width="100%" style="max-width:720px" role="img" aria-labelledby="wf-surface-title">
  <title id="wf-surface-title">The same inline slot in four states: expanded confirm, collapsed, a queued second request with a Replace banner, and a no-renderer fallback card</title>
  <rect x="1" y="1" width="170" height="438" rx="14" fill="none" stroke="#888"/>
  <rect x="9" y="9" width="154" height="200" rx="8" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="86" y="24" font-size="9" fill="#777" text-anchor="middle">transcript (scrolls)</text>
  <rect x="9" y="216" width="154" height="176" rx="8" fill="none" stroke="currentColor"/>
  <text x="17" y="232" font-size="10" fill="currentColor">Delete this worktree?</text>
  <text x="17" y="246" font-size="8" fill="#777">confirm · waiting for you</text>
  <text x="146" y="232" font-size="9" fill="currentColor">collapse</text>
  <text x="17" y="268" font-size="9" fill="currentColor">yes</text>
  <rect x="17" y="262" width="138" height="22" rx="5" fill="none" stroke="currentColor"/>
  <text x="17" y="298" font-size="9" fill="currentColor">no</text>
  <rect x="17" y="292" width="138" height="22" rx="5" fill="none" stroke="#888"/>
  <text x="17" y="328" font-size="9" fill="currentColor">cancel</text>
  <rect x="17" y="322" width="138" height="22" rx="5" fill="none" stroke="#888"/>
  <text x="17" y="360" font-size="8" fill="#777">composer hidden; draft kept</text>
  <rect x="9" y="396" width="154" height="34" rx="6" fill="none" stroke="#888" stroke-dasharray="3 3"/>
  <text x="86" y="417" font-size="8" fill="#777" text-anchor="middle">composer (hidden)</text>
  <rect x="183" y="1" width="170" height="438" rx="14" fill="none" stroke="#888"/>
  <rect x="191" y="9" width="154" height="290" rx="8" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="268" y="24" font-size="9" fill="#777" text-anchor="middle">transcript, readable</text>
  <rect x="191" y="306" width="154" height="34" rx="8" fill="none" stroke="currentColor"/>
  <text x="199" y="320" font-size="10" fill="currentColor">Delete this worktree?</text>
  <text x="199" y="332" font-size="8" fill="#777">confirm · 1 waiting</text>
  <text x="330" y="320" font-size="9" fill="currentColor">expand</text>
  <text x="330" y="333" font-size="9" fill="currentColor">×</text>
  <rect x="191" y="348" width="154" height="46" rx="6" fill="none" stroke="#888" stroke-dasharray="3 3"/>
  <text x="268" y="375" font-size="8" fill="#777" text-anchor="middle">collapsed: header only</text>
  <rect x="191" y="402" width="154" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="268" y="420" font-size="8" fill="#777" text-anchor="middle">composer hidden</text>
  <rect x="365" y="1" width="170" height="438" rx="14" fill="none" stroke="#888"/>
  <rect x="373" y="9" width="154" height="160" rx="8" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="450" y="24" font-size="9" fill="#777" text-anchor="middle">transcript</text>
  <rect x="373" y="176" width="154" height="220" rx="8" fill="none" stroke="currentColor"/>
  <text x="381" y="192" font-size="10" fill="currentColor">Pick a branch</text>
  <text x="381" y="206" font-size="8" fill="#777">select · 1 waiting</text>
  <text x="505" y="192" font-size="9" fill="currentColor">collapse</text>
  <rect x="373" y="214" width="154" height="24" rx="0" fill="none" stroke="#888"/>
  <text x="381" y="230" font-size="8" fill="currentColor">1 new request waiting</text>
  <rect x="497" y="218" width="26" height="16" rx="4" fill="none" stroke="currentColor"/>
  <text x="502" y="230" font-size="7" fill="currentColor">Repl.</text>
  <text x="381" y="258" font-size="9" fill="currentColor">main</text>
  <rect x="381" y="252" width="138" height="20" rx="5" fill="none" stroke="#888"/>
  <text x="381" y="286" font-size="9" fill="currentColor">feature-x</text>
  <rect x="381" y="280" width="138" height="20" rx="5" fill="none" stroke="#888"/>
  <text x="381" y="314" font-size="9" fill="currentColor">cancel</text>
  <rect x="381" y="308" width="138" height="20" rx="5" fill="none" stroke="#888"/>
  <text x="381" y="342" font-size="8" fill="#777">Replace cancels the active</text>
  <text x="381" y="354" font-size="8" fill="#777">request and promotes this one</text>
  <rect x="373" y="404" width="154" height="26" rx="6" fill="none" stroke="#888" stroke-dasharray="3 3"/>
  <text x="450" y="421" font-size="8" fill="#777" text-anchor="middle">composer hidden</text>
  <rect x="547" y="1" width="172" height="438" rx="14" fill="none" stroke="#888"/>
  <rect x="555" y="9" width="156" height="330" rx="8" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="633" y="24" font-size="9" fill="#777" text-anchor="middle">transcript</text>
  <rect x="555" y="346" width="156" height="52" rx="8" fill="none" stroke="currentColor"/>
  <text x="563" y="362" font-size="10" fill="currentColor">Extension panel</text>
  <text x="563" y="374" font-size="8" fill="#777">panel · waiting for you</text>
  <rect x="563" y="380" width="140" height="44" rx="6" fill="none" stroke="#888" stroke-dasharray="3 3"/>
  <text x="633" y="398" font-size="9" fill="currentColor" text-anchor="middle">This panel cannot be shown yet</text>
  <text x="633" y="412" font-size="8" fill="#777" text-anchor="middle">no renderer for “sheet” · cancel request</text>
  <rect x="555" y="406" width="156" height="26" rx="6" fill="none" stroke="#888" stroke-dasharray="3 3"/>
  <text x="633" y="423" font-size="8" fill="#777" text-anchor="middle">composer hidden</text>
</svg>
```

### A2UI, timeout and re-ask

```svg
<svg viewBox="0 0 720 400" width="100%" style="max-width:720px" role="img" aria-labelledby="wf-a2ui-title">
  <title id="wf-a2ui-title">An A2UI panel with header title suppression, the more-time card, the timeout toast, and a read-only re-ask card</title>
  <rect x="1" y="1" width="230" height="130" rx="12" fill="none" stroke="currentColor"/>
  <text x="14" y="24" font-size="11" fill="currentColor">Project setup</text>
  <text x="14" y="38" font-size="8" fill="#777">panel · waiting for you</text>
  <line x1="1" y1="46" x2="231" y2="46" stroke="#888"/>
  <text x="14" y="64" font-size="9" fill="currentColor">Name</text>
  <rect x="14" y="70" width="150" height="20" rx="4" fill="none" stroke="#888"/>
  <text x="20" y="84" font-size="8" fill="#777">pixip</text>
  <text x="14" y="106" font-size="9" fill="currentColor">Language</text>
  <rect x="14" y="112" width="90" height="12" rx="3" fill="none" stroke="#888"/>
  <text x="14" y="126" font-size="8" fill="#777">header title rendered once; in-panel duplicate removed</text>
  <rect x="247" y="1" width="230" height="130" rx="12" fill="none" stroke="currentColor"/>
  <text x="260" y="24" font-size="11" fill="currentColor">Need more time?</text>
  <text x="260" y="38" font-size="8" fill="#777">more_time · waiting for you</text>
  <text x="260" y="60" font-size="9" fill="currentColor">“Pick a branch” reached its timeout.</text>
  <text x="260" y="72" font-size="9" fill="currentColor">Keep it open?</text>
  <rect x="260" y="88" width="110" height="24" rx="5" fill="none" stroke="currentColor"/>
  <text x="286" y="104" font-size="9" fill="currentColor">more time</text>
  <rect x="380" y="88" width="84" height="24" rx="5" fill="none" stroke="#888"/>
  <text x="400" y="104" font-size="9" fill="currentColor">shelve it</text>
  <rect x="493" y="1" width="226" height="130" rx="12" fill="none" stroke="#888"/>
  <text x="506" y="24" font-size="11" fill="currentColor">Re-ask: Pick a branch</text>
  <text x="506" y="38" font-size="8" fill="#777">reask · waiting for you</text>
  <text x="506" y="60" font-size="9" fill="currentColor">Pick a branch timed out after 10h with</text>
  <text x="506" y="72" font-size="9" fill="currentColor">no answer. Ask the agent to show it</text>
  <text x="506" y="84" font-size="9" fill="currentColor">again?</text>
  <rect x="506" y="96" width="80" height="24" rx="5" fill="none" stroke="currentColor"/>
  <text x="524" y="112" font-size="9" fill="currentColor">re-ask</text>
  <rect x="594" y="96" width="78" height="24" rx="5" fill="none" stroke="#888"/>
  <text x="612" y="112" font-size="9" fill="currentColor">dismiss</text>
  <rect x="14" y="160" width="330" height="52" rx="10" fill="none" stroke="#888"/>
  <text x="26" y="180" font-size="10" fill="currentColor">Question needs more time — keep it or shelve it</text>
  <text x="26" y="196" font-size="8" fill="#777">toast over the composer while the surface swaps in the more-time card</text>
  <rect x="360" y="160" width="360" height="52" rx="10" fill="none" stroke="#888"/>
  <text x="372" y="180" font-size="10" fill="currentColor">Question timed out — re-ask it if you still need it</text>
  <text x="372" y="196" font-size="8" fill="#777">surface card removed without answering; re-ask card arrives after the snapshot</text>
  <text x="14" y="242" font-size="9" fill="#777">The re-ask card is read-only: it never reopens the original dialog. Its button asks the</text>
  <text x="14" y="256" font-size="9" fill="#777">agent to re-issue the same call, which arrives again as a normal blocking request.</text>
  <rect x="14" y="276" width="700" height="110" rx="10" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="28" y="296" font-size="9" fill="#777">Draft path: panel input → sessionStorage[pixip.panel.&lt;id&gt;] → shelved into the timeout record →</text>
  <text x="28" y="310" font-size="9" fill="#777">restored into the reissued panel. The hub never reads it; it only carries `draft` on the record.</text>
  <text x="28" y="332" font-size="9" fill="#777">The renderer bundle (486 KB minified, ~136 KB gzip) is fetched on the first A2UI panel only; a</text>
  <text x="28" y="346" font-size="9" fill="#777">payload with unknown component types gets a card naming them instead of a half-drawn surface.</text>
</svg>
```

### Decision flow

```svg
<svg viewBox="0 0 900 420" width="100%" style="max-width:900px" role="img" aria-labelledby="wf-flow-title">
  <title id="wf-flow-title">Decision flow: an extension request becomes a toast, a dialog or a panel; answered, cancelled, timed out with a browser attached, or expired with none; then recorded and re-asked</title>
  <rect x="10" y="24" width="140" height="40" rx="8" fill="none" stroke="currentColor"/>
  <text x="28" y="49" font-size="11" fill="currentColor">request arrives</text>
  <rect x="190" y="8" width="130" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="200" y="26" font-size="9" fill="currentColor">notify → toast</text>
  <rect x="190" y="40" width="130" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="200" y="58" font-size="9" fill="currentColor">setStatus / widget</text>
  <rect x="190" y="72" width="130" height="26" rx="6" fill="none" stroke="currentColor"/>
  <text x="200" y="90" font-size="9" fill="currentColor">blocking → surface</text>
  <line x1="150" y1="44" x2="190" y2="21" stroke="#888"/>
  <line x1="150" y1="44" x2="190" y2="53" stroke="#888"/>
  <line x1="150" y1="44" x2="190" y2="85" stroke="#888"/>
  <rect x="360" y="72" width="150" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="372" y="90" font-size="9" fill="currentColor">one active + queue</text>
  <rect x="360" y="108" width="150" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="372" y="126" font-size="9" fill="currentColor">collapsed / expanded</text>
  <line x1="320" y1="85" x2="360" y2="85" stroke="#888"/>
  <line x1="320" y1="85" x2="360" y2="121" stroke="#888"/>
  <rect x="550" y="60" width="130" height="26" rx="6" fill="none" stroke="currentColor"/>
  <text x="562" y="78" font-size="9" fill="currentColor">answer → Pi</text>
  <rect x="550" y="94" width="130" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="562" y="112" font-size="9" fill="currentColor">cancel → Pi</text>
  <line x1="510" y1="85" x2="550" y2="73" stroke="#888"/>
  <line x1="510" y1="85" x2="550" y2="107" stroke="#888"/>
  <rect x="710" y="60" width="170" height="26" rx="6" fill="none" stroke="currentColor"/>
  <text x="722" y="78" font-size="9" fill="currentColor">cache entry dropped</text>
  <line x1="680" y1="73" x2="710" y2="73" stroke="#888"/>
  <line x1="680" y1="107" x2="710" y2="76" stroke="#888"/>
  <rect x="360" y="170" width="150" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="372" y="188" font-size="9" fill="currentColor">no answer, attached</text>
  <rect x="360" y="206" width="150" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="372" y="224" font-size="9" fill="currentColor">no answer, detached</text>
  <line x1="435" y1="134" x2="435" y2="170" stroke="#888"/>
  <line x1="435" y1="134" x2="435" y2="206" stroke="#888"/>
  <rect x="550" y="162" width="150" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="562" y="176" font-size="9" fill="currentColor">need more time? card</text>
  <text x="562" y="187" font-size="8" fill="#777">2 min, else shelve</text>
  <rect x="550" y="206" width="150" height="26" rx="6" fill="none" stroke="currentColor"/>
  <text x="562" y="224" font-size="9" fill="currentColor">expire now</text>
  <line x1="510" y1="183" x2="550" y2="178" stroke="#888"/>
  <line x1="510" y1="219" x2="550" y2="219" stroke="#888"/>
  <rect x="550" y="250" width="150" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="562" y="268" font-size="9" fill="currentColor">more time → reset</text>
  <line x1="625" y1="192" x2="625" y2="250" stroke="#888"/>
  <rect x="550" y="300" width="150" height="40" rx="6" fill="none" stroke="currentColor"/>
  <text x="562" y="316" font-size="9" fill="currentColor">cancelled + ask agent</text>
  <text x="562" y="330" font-size="8" fill="#777">YES / NO, 60 s, default yes</text>
  <line x1="625" y1="232" x2="625" y2="300" stroke="#888"/>
  <line x1="625" y1="276" x2="625" y2="300" stroke="#888"/>
  <rect x="740" y="300" width="140" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="752" y="318" font-size="9" fill="currentColor">NO → nothing kept</text>
  <rect x="740" y="336" width="140" height="26" rx="6" fill="none" stroke="currentColor"/>
  <text x="752" y="354" font-size="9" fill="currentColor">YES → record</text>
  <line x1="700" y1="318" x2="740" y2="314" stroke="#888"/>
  <line x1="700" y1="330" x2="740" y2="346" stroke="#888"/>
  <rect x="550" y="374" width="150" height="34" rx="6" fill="none" stroke="currentColor"/>
  <text x="562" y="390" font-size="9" fill="currentColor">re-ask card on return</text>
  <text x="562" y="401" font-size="8" fill="#777">read-only, draft offered back</text>
  <line x1="810" y1="362" x2="810" y2="391" stroke="#888"/>
  <line x1="810" y1="391" x2="700" y2="391" stroke="#888"/>
  <rect x="360" y="374" width="150" height="34" rx="6" fill="none" stroke="#888"/>
  <text x="372" y="390" font-size="9" fill="currentColor">re-ask → agent reruns</text>
  <text x="372" y="401" font-size="8" fill="#777">same call, new request</text>
  <line x1="550" y1="391" x2="510" y2="391" stroke="#888"/>
  <line x1="435" y1="374" x2="435" y2="134" stroke="#888" stroke-dasharray="3 3"/>
</svg>
```

## Technical notes (port-relevant)

### The passthrough seam

`extension_ui_request` is an ordinary Pi event: `src/rpc.ts` parses the line only
to correlate responses, and the hub splices the original string into
`{"t":"event","ev":<raw>}`. The client parses it once for routing and builds the
answer as `{ t: "ui", id, value | confirmed | cancelled }`, which the hub turns
into `{ type: "extension_ui_response", id, ...fields }` for the child. No field is
rewritten: a select answer stays the original option value and an A2UI action
stays the JSON string the client produced. Server-side interpretation stops at
`method`, `id` and `title`/`message`.

The `pi-host` binary adds `method: "panel"` and `ctx.ui.panel(payload, opts?)`
to the same protocol, resolving with the verbatim `value` or `undefined` on cancel
like the stock dialogs. The host does not validate the panel schema.
`hello.capabilities` advertises `panel`, and the legacy `pi --mode rpc` backend
has no panel method, so panels only exist on the host backend.

### Where pending requests live

The hub caches blocking requests per live session, keyed by Pi request id, as
`pendingUi` on the `LiveSession` (`src/hubLive.ts`): original frame, parsed
request, raw line, start time and two timers. `subscribe` replays those frames
inside the attach path before `get_entries`, so replay cannot race the snapshot
and a replayed active id is a client-side no-op. The client queue
(`surfaceQueue.js`) is DOM-free so the no-orphan and composer-state rules are unit
tested.

Timed-out records are separate: `<data-dir>/pending-ui/<key>.json`, an array
keyed by logical session id, written atomically through a temp file and a per-key
serialized write map (`src/pendingReask.ts`). Each record keeps the raw request
(truncated to 16 000 characters only in the prompt), method, session id, cwd,
timeout ms, `timedOutAt`, the attached flag and an optional panel `draft`.
Records are removed on re-ask or dismiss, and the file goes with the last one.
`awaitingUser` means "pending cache non-empty or records exist", re-derived after
every mutation including the agent's YES/NO.

### Timeout and re-ask sequencing

`armPendingUiTimer` uses the attached timeout when the session has subscribers
and the detached timeout otherwise, and re-arms on every attach and detach.
Attached expiry broadcasts `ui_need_time` and starts a more-time window; detached
expiry calls `expirePendingUi` directly. Expiry always broadcasts `ui_timeout`
first, then sends `cancelled: true` to Pi, so the card is gone before the agent
can emit anything else for that turn. The follow-up prompt is a normal `prompt`
with `followUp` delivery, parsed only from the first word of the reply because
prompts and prose routinely contain "YES or NO". Re-ask is again just a `prompt`:
recovery adds no RPC verb, so the wire surface stays unchanged for a Rust port.
The `panel_draft` client frame is currently unused; drafts travel inside the
re-ask record.

### Surface layout boundary

`#surface` is a flex sibling between `#log` and the composer, capped at
`100% - 2.5rem` of the session height with an internally scrolling body and the
same 104ch cap as the transcript; layout stays one column at every width.
`--surface-height` is updated from a `ResizeObserver` so the jump pill clears the
panel, and a transcript pinned to the newest entry is re-pinned when the panel
grows. A port must keep the slot content-sized, keep one scroll container for the
transcript, and hide the composer for every blocking method.

# Bundled extensions

pixip ships three optional Pi extensions and one built-in surface for extension chrome. `pixip-questionnaire` lets an agent ask a structured question, `pixip-show-image` puts one image in front of the user, and `pixip-inbox` leaves a durable message for later. Separately, any extension can paint statuses and widgets around the footer. This area covers what an agent can ask or show, and how it appears; the inbox page, panel host and transcript belong elsewhere.

## Contents

- [User stories](#user-stories)
- [What ships](#what-ships)
- [Asking a question](#asking-a-question)
- [The panel when pixip is the host](#the-panel-when-pixip-is-the-host)
- [When typed text or a panel is not available](#when-typed-text-or-a-panel-is-not-available)
- [Showing an image](#showing-an-image)
- [Footer statuses and widgets](#footer-statuses-and-widgets)
- [Installing and opting in](#installing-and-opting-in)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want an agent to ask a multi-part question with buttons or free text, and to see the answer I gave.
- As a user, I want to ask for more information without losing earlier answers.
- As a user whose host cannot collect typed text, I want a clear handoff to answer in chat.
- As a user, I want an agent to show me an image inline instead of just a link.
- As a user, I want extension footer widgets and statuses to appear when the extension is loaded and disappear when it is not.
- As a user, I want bundled extensions to be optional and not to break my other Pi plugins.

## What ships

| Package | Tool | What the user sees |
| --- | --- | --- |
| `pixip-questionnaire` | `questionnaire` | An inline A2UI panel in pixip, a tabbed TUI widget, or sequential dialogs |
| `pixip-show-image` | `show_image_to_user` | A thumbnail on the tool card, or a `file://` link in a plain TUI |
| `pixip-inbox` | `inbox_send`, `inbox_report` | A message in the dashboard inbox; the inbox page is a separate area |

The extensions are ordinary Pi packages. pixip registers none of them itself: it spawns the real `pi` binary and shares the user's extension set, so a tool exists in a session exactly when that session loads the package.

## Asking a question

The `questionnaire` tool takes a `questions` array. Each entry has a stable `id`, an optional short `label` (defaulting to `Q1`, `Q2`, …), the `prompt` the user reads, and a `widget`.

A `choice` question carries `options` of `{value, label, description?}` and an optional `multiple`. Labels are displayed with a numeric prefix; the agent receives the option `value`, not the label, so a later wording change cannot break a caller. A `text` question collects free-form input and must not carry options. A choice question always also offers a "Type your own answer" field; a single-select answer that is only typed text comes back marked as custom so the model can tell a pick from prose.

Every question also offers "I need more information". Choosing it does not discard or cancel the questionnaire: it records `moreInfo` on that question, and Submitting still returns the other answers. The model is asked to explain those questions in plain text and wait, rather than re-asking the whole set. Multi-question calls are split into tabs, one per question, with a shared Submit; the label is the tab title, so a caller that omits labels still gets usable tabs.

Validation is strict where a guess would hide a mistake. An empty question list, a missing id or prompt, a duplicate id, an unknown widget, a choice question with no options, duplicate option values, a text question with options, and `multiple` on a text question are all tool errors the agent can read and fix. Only a caller that omits `widget` entirely gets the deprecated inference: options mean `choice`, otherwise `text`.

A cancel is a decision, not a timeout. The result says the user dismissed the questionnaire without submitting and that the agent should stop and wait. An unavailable or lost panel is the opposite: the tool returns an error asking the model to ask in plain text.

## The panel when pixip is the host

When the host offers a blocking panel, the questionnaire is drawn as an A2UI v1.0 surface in the inline panel between the transcript and the composer. It is not a modal. The panel is collapsible, the composer is hidden while it is open, and a draft typed before the question is kept and restored afterwards.

The surface has a title, a tab per question with the prompt at the top, a `ChoicePicker` for choices, a `TextField` labelled "Type your own answer" for every question, and a per-question "I need more information" checkbox. A footer row holds **Cancel** and **Submit**. On a phone that is one scrollable card with real buttons.

**Cancel** closes the panel and returns a dismissal. **Submit** returns every answer, including typed text and `moreInfo` marks. The agent's tool result repeats the answers one line per question (`Scope: user selected: 2. Later`), so the conversation shows what was answered even if the panel is gone.

The surface is not written to session history. Only a still-pending panel is replayed from the hub's cache when a client attaches; a completed one leaves just the answer in the tool result.

## When typed text or a panel is not available

Transport is chosen once, per call, in a fixed order: A2UI inline panel, then a TUI custom widget, then sequential `select`/`input` dialogs. The first transport the host actually offers wins.

The TUI path uses Pi's own custom UI: tabs per question, Up/Down and Enter, toggle for multi-select, a free-form row, and a Submit tab for multi-question calls. The dialog path is for RPC and ACP hosts with select and input but no panel or custom widget. It asks one question at a time, with the position in the title (`Scope (2/3): …`). Multi-select loops over check rows plus Done, a single-select question offers the options plus "Type your own answer" and "More information", and a multi-question run ends with a "Review" dialog before Submit.

Some hosts cannot collect typed text at all — the stock `pi-acp` adapter cancels input requests. A text field there would end in a silent dismissal, so the fallback drops it: a text question offers "Answer this in chat", and a multi-select question offers "Add an item in chat". Both return a deferred result: already collected answers travel back, the affected questions do not, and the model is told to ask those questions in plain text. This is a refusal to pretend, not an error.

A panel that closes with no message is a failure, not a dismissal: it returns an error asking the agent to ask in plain text. The hub owns the pending-request lifetime (5 hours detached, 10 hours with a browser), so the extension sets no timeout and a reopened tab sees the question again.

## Showing an image

`show_image_to_user` takes an absolute `path` and an optional `caption`. One image per call; PNG, JPEG, GIF and WebP are supported. A relative path, a missing file, a directory or an unsupported format is a tool error the agent can correct; the user never sees a broken card.

Size decides the payload. Up to 1 MB the image is returned unchanged. Over 1 MB and up to 20 MB the tool returns a thumbnail (longest edge 1024 px, at most 512 KB) and says the original is over the limit. Over 20 MB the file is not read at all and only a link comes back; a thumbnail that cannot be produced falls back to the link too. Pi's own tool-result normalization still runs afterwards, so this policy is about intentional display payloads, not provider limits.

The result carries `details: {path, caption?, bytes, thumbnail, overSourceLimit, tooLarge}`, and that is what pixip uses. On the tool card the image is visible: a thumbnail above a folded output block, with caption, size note and a working download link. Tapping it opens the image viewer. A plain TUI keeps the image content and the `file://` link. Only `show_image_to_user` gets this treatment, so an incidental screenshot in another tool result stays text.

## Footer statuses and widgets

Extensions can decorate the footer with Pi's fire-and-forget UI requests, `setStatus` and `setWidget`. They are not dialogs: nothing blocks, nothing waits for an answer, and the agent does not see them.

A status is a keyed string. pixip shows the current statuses joined into one dim footer line in first-seen order, using ` · ` between entries; updating an existing key replaces it in place, and an empty or missing string removes that key. No keys means the line is hidden entirely, so a session with no such extension looks exactly like it always did. Status text may contain ANSI styling, escaped before it becomes HTML.

A widget is a keyed block of plain text lines with a placement of above or below the footer. Above-widgets sit above the status line and below-widgets below it, each in first-seen key order. Lines preserve newlines and wrap; a widget taller than about nine lines scrolls inside its own box rather than pushing the footer off-screen. An empty line array removes the key.

Both are immediate: each request is applied as it arrives and repaints the footer in the same turn. On a new tab or a reconnect, the hub replays its current cache — above-widgets, then statuses, then below-widgets. The cache belongs to the live session and is discarded when the session stops.

One extension uses a related one-shot signal rather than a footer widget: `pixip-inbox` announces on load that the agent can reach the inbox, and the dashboard hides its inbox bar until that announcement is seen or a message arrives.

## Installing and opting in

All three extensions are local-checkout packages, not published registry entries:

```bash
pi install /path/to/pixip/extensions/pixip-questionnaire
pi install /path/to/pixip/extensions/pixip-show-image
pi install /path/to/pixip/extensions/pixip-inbox
```

`pixip-inbox` can also be loaded for a single run with `pi -e /path/to/pixip/extensions/pixip-inbox/src/index.ts`. Nothing is enabled by default: the session's own Pi extension set decides.

`pixip-questionnaire` replaces the older `pi_questionare`, but installing it does not touch the old package. The documented migration is install, try the new tool in a pixip session, then `pi list`, then `pi remove /path/to/pi_questionare`. Removal changes that user's Pi settings only (or the project settings for a `-l` install). Keeping both installed is not dangerous; it just leaves two similar tools visible to the model.

The no-shim rule is what makes this safe. pixip does not wrap Pi's extension API, intercept a tool call or translate an extension's UI request into something private. `show_image_to_user` returns a normal Pi tool result, `questionnaire` uses the host's normal panel/custom/dialog calls, and `inbox_send` is a normal POST to the daemon. An extension that predates pixip keeps working because pixip never asks it to know about pixip.

## Wireframes

A questionnaire across its states, then an image card and the decorated footer:

<svg viewBox="0 0 780 330" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-label="Four screens: choice question, text question, more-information state, image card with add-on footer widgets and statuses">
  <rect x="4" y="4" width="772" height="322" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">BUNDLED EXTENSION SURFACES · WHAT THE USER SEES</text>

  <rect x="16" y="38" width="180" height="274" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">1 · CHOICE</text>
  <text x="26" y="78" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">Scope</text>
  <rect x="26" y="86" width="58" height="15" rx="7" fill="#2b2440" stroke="#4b3f6b"/>
  <text x="34" y="97" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">Scope</text>
  <text x="92" y="97" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">Priority</text>
  <text x="26" y="118" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">What should this ticket</text>
  <text x="26" y="130" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">cover?</text>
  <rect x="26" y="140" width="160" height="18" rx="5" fill="#241f33" stroke="#4b3f6b"/>
  <text x="33" y="152" font-family="ui-monospace, monospace" font-size="7" fill="#e7e3f2">• 1. The data model</text>
  <rect x="26" y="162" width="160" height="18" rx="5" fill="#241f33" stroke="#322b45"/>
  <text x="33" y="174" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">○ 2. The API edges</text>
  <rect x="26" y="190" width="160" height="18" rx="5" fill="#1b1726" stroke="#322b45"/>
  <text x="33" y="202" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">Type your own answer</text>
  <rect x="26" y="214" width="160" height="16" rx="4" fill="#1b1726" stroke="#322b45"/>
  <text x="33" y="225" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">☐ I need more information</text>
  <rect x="26" y="276" width="70" height="20" rx="6" fill="#241f33" stroke="#322b45"/>
  <text x="44" y="289" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">Cancel</text>
  <rect x="104" y="276" width="82" height="20" rx="6" fill="#6c5ce7" stroke="#8b7cf0"/>
  <text x="127" y="289" font-family="ui-monospace, monospace" font-size="7" fill="#ffffff">Submit</text>
  <text x="26" y="258" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">typed text is an answer,</text>
  <text x="26" y="268" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">not a different mode.</text>

  <rect x="206" y="38" width="180" height="274" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="216" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">2 · TEXT + MORE INFO</text>
  <text x="216" y="78" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">Notes</text>
  <rect x="216" y="86" width="52" height="15" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="223" y="97" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">Scope</text>
  <rect x="274" y="86" width="76" height="15" rx="7" fill="#2b2440" stroke="#4b3f6b"/>
  <text x="281" y="97" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">Notes</text>
  <text x="216" y="118" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">Anything I should know</text>
  <text x="216" y="130" font-family="ui-monospace, monospace" font-size="8" fill="#cfc9e0">before I start?</text>
  <rect x="216" y="140" width="160" height="42" rx="5" fill="#1b1726" stroke="#4b3f6b"/>
  <text x="223" y="156" font-family="ui-monospace, monospace" font-size="7" fill="#e7e3f2">the deploy window is</text>
  <text x="223" y="168" font-family="ui-monospace, monospace" font-size="7" fill="#e7e3f2">frozen on friday</text>
  <rect x="216" y="192" width="160" height="16" rx="4" fill="#241f33" stroke="#6c5ce7"/>
  <text x="223" y="203" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">☑ I need more information</text>
  <text x="216" y="226" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">Submit still returns the</text>
  <text x="216" y="236" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">other answers; the model</text>
  <text x="216" y="246" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">explains in chat, then waits.</text>
  <rect x="216" y="276" width="70" height="20" rx="6" fill="#241f33" stroke="#322b45"/>
  <text x="234" y="289" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">Cancel</text>
  <rect x="294" y="276" width="82" height="20" rx="6" fill="#6c5ce7" stroke="#8b7cf0"/>
  <text x="317" y="289" font-family="ui-monospace, monospace" font-size="7" fill="#ffffff">Submit</text>

  <rect x="396" y="38" width="180" height="274" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="406" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">3 · IMAGE CARD</text>
  <text x="406" y="78" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">show_image_to_user</text>
  <rect x="406" y="88" width="160" height="92" rx="6" fill="#0f0d17" stroke="#4b3f6b"/>
  <rect x="446" y="104" width="80" height="50" rx="4" fill="#3b3552"/>
  <circle cx="470" cy="120" r="8" fill="#6c5ce7"/>
  <path d="M450 148 L470 128 L486 144 L496 136 L524 152 Z" fill="#8b7cf0"/>
  <text x="414" y="196" font-family="ui-monospace, monospace" font-size="7" fill="#e7e3f2">Login screen · 412 KB</text>
  <text x="406" y="216" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">▸ output</text>
  <text x="406" y="232" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">over 1 MB → thumbnail</text>
  <text x="406" y="242" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">over 20 MB → link only</text>
  <text x="406" y="258" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">tap the thumbnail to</text>
  <text x="406" y="268" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">open the viewer.</text>
  <text x="406" y="290" font-family="ui-monospace, monospace" font-size="7" fill="#6c5ce7">download original ↗</text>

  <rect x="586" y="38" width="180" height="274" rx="10" fill="#1d1a29" stroke="#322b45"/>
  <text x="596" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#9b93b4">4 · FOOTER ADD-ONS</text>
  <text x="596" y="82" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">transcript ends above</text>
  <rect x="596" y="150" width="160" height="34" rx="5" fill="#241f33" stroke="#4b3f6b"/>
  <text x="603" y="165" font-family="ui-monospace, monospace" font-size="7" fill="#c4bcd8">above widget</text>
  <text x="603" y="177" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">extension-supplied lines</text>
  <text x="596" y="200" font-family="ui-monospace, monospace" font-size="7" fill="#e0af68">build ok · 2 agents · tests…</text>
  <text x="596" y="216" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">joined statuses, one line,</text>
  <text x="596" y="226" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">first-seen order, · between</text>
  <rect x="596" y="238" width="160" height="26" rx="5" fill="#241f33" stroke="#322b45"/>
  <text x="603" y="254" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">below widget</text>
  <text x="596" y="280" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">no keys → no chrome</text>
  <text x="596" y="294" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">replayed on reattach</text>
</svg>

Transport selection and how an image reaches the user:

<svg viewBox="0 0 780 300" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-label="Decision flow: questionnaire chooses A2UI panel, TUI custom UI or sequential dialogs, with an answer-in-chat handoff; image display chooses thumbnail in pixip or file link in a TUI">
  <rect x="4" y="4" width="772" height="292" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">ONE TOOL CALL · WHO DECIDES THE SURFACE</text>

  <rect x="18" y="42" width="150" height="44" rx="8" fill="#241f33" stroke="#6c5ce7"/>
  <text x="30" y="60" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">questionnaire</text>
  <text x="30" y="74" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">validate widget + options</text>

  <path d="M168 64 H210" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <defs>
    <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 Z" fill="#6f6889"/>
    </marker>
  </defs>

  <rect x="212" y="42" width="150" height="44" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="224" y="60" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">ctx.ui.panel?</text>
  <text x="224" y="74" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">pixip pi-host offers it</text>
  <path d="M362 64 H404" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <rect x="406" y="40" width="170" height="48" rx="8" fill="#241f33" stroke="#4b6b5a"/>
  <text x="418" y="58" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">1 · A2UI inline panel</text>
  <text x="418" y="72" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">tabs, choice, text, Submit</text>
  <text x="418" y="82" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">closed with no action = error</text>

  <path d="M287 86 V116" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <rect x="212" y="118" width="150" height="44" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="224" y="136" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">tui + ui.custom?</text>
  <text x="224" y="150" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">plain terminal Pi</text>
  <path d="M362 140 H404" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <rect x="406" y="116" width="170" height="48" rx="8" fill="#241f33" stroke="#4b3f6b"/>
  <text x="418" y="134" font-family="ui-monospace, monospace" font-size="8" fill="#c4bcd8">2 · TUI custom widget</text>
  <text x="418" y="148" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">arrow keys, toggles, free-form</text>
  <text x="418" y="158" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">same answers, terminal shape</text>

  <path d="M287 162 V192" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <rect x="212" y="194" width="150" height="44" rx="8" fill="#1d1a29" stroke="#322b45"/>
  <text x="224" y="212" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">typed text possible?</text>
  <text x="224" y="226" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">pi-acp cannot collect it</text>
  <path d="M362 216 H404" stroke="#6f6889" stroke-width="1.2" marker-end="url(#arrow)"/>
  <rect x="406" y="192" width="170" height="48" rx="8" fill="#241f33" stroke="#b08a3e"/>
  <text x="418" y="210" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">3 · sequential dialogs</text>
  <text x="418" y="224" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">select / input, review before Submit</text>
  <text x="418" y="234" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">no typed text → "Answer in chat"</text>

  <line x1="18" y1="252" x2="762" y2="252" stroke="#322b45"/>
  <text x="18" y="272" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">show_image_to_user → pixip: thumbnail on the tool card, tap to enlarge · plain TUI: image content + file:// link</text>
</svg>

## Port-relevant technical notes

Port notes only; the user-facing rules above are the contract.

### Transport selection and the panel contract

The questionnaire picks its transport by capability, not configuration: `typeof ctx.ui.panel === "function"` first, `ctx.mode === "tui" && typeof ctx.ui.custom === "function"` second, `ui.select` third. `pi-host` adds the panel method; `--use-system-pi` has no panel and falls through to dialogs. `hostCollectsTypedText()` reads `/proc` up the parent chain for `pi-acp` (overridable with `PIXIP_QUESTIONNAIRE_TYPED_TEXT`), a Linux-only heuristic that returns true when it cannot read the chain.

The panel payload is `{title, mode: "a2ui", surfaceId, messages}` with exactly one `createSurface` and the v1.0 Basic catalog; components are `Column`, `Text`, `Tabs`, `ChoicePicker`, `TextField`, `CheckBox`, `Button`, `Row`. Data model is `{answers: {[questionId]: {selected: [], custom: "", moreInfo: false}}}`; `sendDataModel` is false. Submit sends `{event: {name: "submit", context: {answers: {"@path": "/answers"}}}}`; Cancel sends `{event: {name: "cancel"}}`.

The hub passes panel `value` through verbatim as an action JSON string; the extension decodes string or object. `{name:"cancel"}` or `{cancelled:true}` is a dismissal; `{name:"submit"}` normalizes `context.answers`; an optional legacy `{name:"more_info", …}` returns the other answers and drops the affected one; empty or unsupported messages become an error tool result. Panel lifetime belongs to the hub. `@a2ui/web_core` is a devDependency used only to validate the surface in tests, so the shipped extension has no A2UI runtime dependency.

The TUI path is `ctx.ui.custom` from `@earendil-works/pi-tui`; the dialog path uses `select`/`input`. Every outcome is normalized into `QuestionnaireDetails {questions, answers, cancelled, error?}`.

### Add-on frame cache

`setStatus` and `setWidget` are ordinary Pi `extension_ui_request` records, forwarded to the socket verbatim. `src/client/addonUi.js` is the DOM-free model: two `Map`s preserve first-seen order, an update replaces in place, an empty value or line array deletes. `src/hubLive.ts` keeps a parallel cache of the raw frames, and `hubSession.addonUiFrames()` emits them in render order: above-widgets, statuses, below-widgets. `server.ts` replays that list after `snapshot`, `resume` replays it too, and `hub.stop` drops the cache. Client-side, `state.addon` is reset on open, included in the session cache, and `sheets.handleUiRequest` applies addon requests before the surface fallback. Widget text goes through `ansiToHtml`, which escapes markup; the container is hidden when empty.

### Image result contract

`showImageToUser` validates absolute path, regular file and a supported MIME through Pi's `detectSupportedImageMimeTypeFromFile`, then branches on `stat.size`: at or below 1 MiB returns the bytes plus text; at or below 20 MiB resizes through Pi's `resizeImage({maxWidth:1024, maxHeight:1024, maxBytes:512*1024})` and falls back to link-only on failure; above 20 MiB never reads. `details` is the stable seam. `render.js`'s `toolResultParts` only converts an image block into a card when `toolName === "show_image_to_user"`; `sessionFileHref` maps the path to `/api/sessions/:id/files?path=…`. Other extensions need no pixip awareness.

### Inbox tool seam

`inbox_send` and `inbox_report` POST to `${PIXIP_DAEMON_URL}/api/inbox[ /reports]`, with `Authorization: Bearer ${PIXIP_INBOX_TOKEN}` only when the token is set. The hub injects both variables into each child and owns `inbox.json` and `reports/`; the extension never guesses an address and never writes files. Failures (missing daemon, bad token, validation, oversize) come back as tool error text. `announceInbox()` is a best-effort `POST /api/inbox/extension` with a 5 s timeout whose failure is ignored. `REPORT_ACTIONS` and `INBOX_PURPOSES` are the single source for schema enum and runtime checks.

### No-shim invariant

The three tools are registered with `pi.registerTool`; the only new UI capability is the host's `panel` method from `pixip-pi-host`, which rides the existing `extension_ui_request`/`extension_ui_response` frames. Nothing in the hub parses A2UI, rewrites a tool result or special-cases a package, so an existing Pi extension behaves identically inside and outside pixip.

## Boundaries

This area owns the three bundled tools and the add-on footer surface: schemas, transports, result shapes and install story. The panel host, inline surface frame and A2UI rendering belong to extension UI. The inbox page and report viewer belong to inbox; message composition, transcript blocks and the full-screen image viewer belong to transcript. This area covers only how the image gets onto the card.

## Sources

`extensions/pixip-questionnaire/` (`src/index.ts`, `ask.ts`, `questions.ts`, `surface.ts`, `tui.ts`, `README.md`), `extensions/pixip-show-image/` (`src/index.ts`, `show.ts`, `README.md`), `extensions/pixip-inbox/` (`src/index.ts`, `inbox.ts`, `README.md`), `src/client/addonUi.js`, `src/client/sessionView.js`, `src/client/sheets.js`, `src/client/a2ui.js`, `src/client/render.js`, `src/client/status.css`, `src/client/index.html`, `test/addonUi.test.js`, `test/addon-ui.test.ts`, `src/hubLive.ts`, `src/hubSession.ts`, `src/server.ts`, `pi-host/README.md`, `README.md` (inline panels, HTML reports), `docs/TUI-parity.md` (extension panels and questionnaires).

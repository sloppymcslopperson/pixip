# pixip-questionnaire

A `questionnaire` tool for Pi that renders an **A2UI v1.0 surface in pixip's
inline panel**, with TUI and dialog fallbacks for other hosts. It replaces
`pi_questionare` for pixip sessions; the old package is not modified or removed
by installing this one.

## Transport

The tool picks the first transport the host offers:

1. **A2UI panel** — `ctx.ui.panel(payload, { timeout: 15 min })` from
   `pixip-pi-host`. The payload is `{title, mode: "a2ui", surfaceId, messages}`
   with one `createSurface` and the Basic catalog. Every question gets a
   `ChoicePicker` (choice widgets) and/or a `TextField` ("Type your own answer"),
   one `Tabs` entry per question, a per-question "I need more information"
   checkbox at the bottom, and a footer with Cancel and Submit. The checkbox
   is an answer field for that question (`moreInfo: true`), so it never closes
   the panel or discards other questions. Submit returns the A2UI action
   `{name:"submit", context:{answers:{...}}}`, Cancel returns
   `{name:"cancel"}`. A panel that closes with no message is an **error**, not a
   dismissal: the result asks the model to ask in plain text.
2. **TUI custom UI** — `ctx.ui.custom`: tabs per question, Up/Down and Enter,
   multi-select toggles, a free-form row, and a Submit tab for multi-question
   calls.
3. **Sequential dialogs** — `select` / `input`. Hosts that cannot collect typed
   text (the stock `pi-acp` adapter) get an "Answer this in chat" row instead of
   a dead-end text prompt, and multi-select gets "Add an item in chat". Set
   `PIXIP_QUESTIONNAIRE_TYPED_TEXT=0|1` to force either behaviour.

The tool is blocking in every path. There is no deferred result and no second
response channel.

## Input

`questions[]` entries:

```ts
{
  id: string,                 // stable, unique
  label?: string,             // tab label, defaults to Q1, Q2, ...
  prompt: string,
  widget?: "choice" | "text", // new: explicit widget
  options?: { value, label, description? }[],
  multiple?: boolean          // choice only
}
```

`widget` is optional for **deprecated legacy calls**: options mean `choice`,
otherwise `text`. Unknown widgets, a `choice` without options, a `text` with
options, or `multiple` on a text question are validation errors. A backlog
ticket removes the legacy default once callers have moved.

Answers are normalized to option values plus the custom text, with `wasCustom`
for a single-choice answer typed rather than picked. A question can also carry
`moreInfo: true` when the user asked for an explanation; that is an answer for
that question only and Submit still returns all other answers.

## Install

```bash
pi install /path/to/pixip/extensions/pixip-questionnaire
```

The package is local-checkout only and unpublished. To migrate from
`pi_questionare`, install this package, try it in a pixip session, then remove
the old one:

```bash
pi list
pi remove /path/to/pi_questionare
```

Removal affects that user's Pi settings only (or the project settings when it
was installed with `-l`); it does not touch other users. Do not remove the old
plugin until this one works for you.

## Develop

```bash
npm run check
```

`@a2ui/web_core` is a **devDependency** used only to validate the generated
messages against the official v1.0 processor in tests; the shipped extension
emits plain JSON and has no A2UI runtime dependency. The surface is not written
to session history; only a pending panel is replayed by the hub.

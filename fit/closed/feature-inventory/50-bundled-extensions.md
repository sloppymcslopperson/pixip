---
area: bundled-extensions
part: inventory
project: feature-inventory
commit: "4ba4e065e22b4d0f0759de5e5ad11104aba9a620"
---

Capture the extensions pixip ships and the add-on surface they use: questionnaire, inbox, show-image, and footer widgets/statuses. This section is about the agent-facing tools and how their results appear, not the inbox page itself.

### Goal
An inventory reader should understand what each bundled extension lets an agent ask or show, what the user sees, and how installation/opt-in works.

### Scope
- `pixip-questionnaire`: `questionnaire` tool with `choice` (single/multi, always a type-your-own option) and `text` widgets; transport order A2UI inline panel -> TUI custom UI -> sequential dialogs; "Answer this in chat" handoff where typed text is impossible; `more info` answer; validation.
- `pixip-inbox`: agent-facing `inbox_send` message and `inbox_report` report tools; install/opt-in; its consumption UI is owned by the inbox section.
- `pixip-show-image`: `show_image_to_user` with an absolute path and caption; thumbnail in pixip, `file://` link in a plain Pi TUI.
- Add-on widgets and statuses rendered in the footer (`addonUi.js`): extension-provided above/below widgets and status lines, update cadence, and hidden-when-absent behaviour.
- Install/opt-in commands, coexistence with older packages (`pi_questionare`), and the rule that existing Pi extensions keep working untouched.

### User stories to cover
- As a user, I want an agent to ask me a multi-part question with buttons or free text, and to see the answer I gave.
- As a user on a host that cannot collect typed text, I want a clear handoff to answer in chat.
- As a user, I want an agent to show me a specific image inline instead of a link.
- As a user, I want extension-provided footer widgets and statuses to appear when the extension is loaded and disappear when it is not.
- As a user, I want bundled extensions to be optional and not to break my other Pi plugins.

### Wireframes (SVG, no screenshots)
- Series of screens: questionnaire choice/text panel, more-info state, show-image thumbnail, footer add-on widgets/statuses.
- Decision-flow diagram: questionnaire transport selection by host capability, and image display by client.

### Technical notes (port-relevant only)
- Tool schemas and registration, host capability detection, and the no-shim rule for third-party extensions.
- A2UI payload shape for questionnaires and the fallback chain.
- Add-on frame source and lifetime per session.

### Sources to read
`extensions/pixip-questionnaire/*`, `extensions/pixip-inbox/*`, `extensions/pixip-show-image/*`, `src/client/addonUi.js`, `src/client/addonUi` tests, `pi-host/README.md`, `README.md` extension sections, `docs/TUI-parity.md` extension panels.

### Acceptance
- All three bundled extensions and the add-on widget surface are covered, including install/opt-in.
- Each transport/fallback path has a story or note.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/50-bundled-extensions.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

### Completion

When the inventory is finished, send the owner an inbox message from this session: `pixip inbox send --subject "feature inventory: <area> done" --purpose deliverable "<output path, what it covers, and anything you could not cover>"`. That message is how the owner learns the ticket is ready for review.

### Commit

When the work is done, commit it on this worktree's branch with a descriptive message, including the ticket move to `closed/`. Do not push.

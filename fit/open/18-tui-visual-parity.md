The web UI is only stylistically close to the TUI, not identical, and the gap is now measurable.

### What the TUI does that we do not

- Markdown is rendered in the TUI; the transcript currently shows raw `| tables |`, `**bold**` and backticks.
- Syntax highlighting and diff rendering for tool output (`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext`); we render ANSI only.
- Boxed user messages (`userMessageBg`) and boxed tool results (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`) with `toolTitle` / `toolOutput` colours; we use left borders instead.
- TUI glyphs and spacing (title bar, working indicator) have no equivalent here.

### Theme plumbing (what we learned)

- Theme values are `okhsl(...)` strings with a `vars` indirection table; browsers do not support okhsl, so serving a theme requires resolving vars and converting okhsl → sRGB in the hub.
- Built-ins are `dist/modes/interactive/theme/{dark,light}.json`; there is no user `themes/` directory on this box, and the configured `theme.name = "rose-pine"` does not resolve to a built-in, so the TUI is likely rendering the dark fallback.
- Terminal glyphs are best-effort: HTML presentation of the same colours, not a character-cell copy.

### Scope

Two separable pieces: (1) a `theme` frame with resolved colours mapped to CSS variables, (2) markdown + diff rendering in the client. (2) is what actually makes it *look* like the TUI; (1) alone just changes the palette.

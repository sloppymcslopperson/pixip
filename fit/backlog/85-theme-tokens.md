The client uses a hand-picked palette while the TUI uses a resolved theme, so colours differ even after markdown lands.

### Goal

Serve the active theme from the hub as CSS variables, with the built-in dark theme as the fallback.

### Notes (already investigated)

- Theme JSON lives at `dist/modes/interactive/theme/{dark,light}.json` in the Pi package; there is no user `themes/` directory on this box.
- Values are `okhsl(...)` plus a `vars` indirection table; browsers do not support okhsl, so the hub must resolve vars and convert okhsl → sRGB.
- `theme.name = "rose-pine"` in this box's settings does not resolve to a built-in, so the TUI is already on the dark fallback. A `theme` frame (name + resolved tokens) keeps parity honest.

### Done when

- The hub reads the configured theme name, resolves it from user themes then built-ins, and sends resolved tokens to the client.
- The client maps tokens (`accent`, `border`, `muted`, `dim`, `userMessageBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput`) onto CSS variables, with no visual regression at 390 or 1280.
- Syntax highlighting and diff colours stay out of scope (separate ticket).

---
grilled: true
leg: dogfooding-test
---

Add a transcript text-size control: a compact `A−`/`A+` pair in the header with a 50–150 % range, persisted per device, scaling only the transcript so the composer and the rest of the chrome stay fixed. This is the first ticket pixip is meant to work on itself, as a test of the dogfooding setup.

### Goal

Readability/width trade-off on phone and desktop: shrink the transcript to fit more on screen, grow it when reading. Transcript only; the control, composer, footer and session list keep their size. Supersedes the original "per session or for all new sessions" wording: the size is a device-wide transcript preference, not session state.

### Done when

- The session view header shows a compact `A−`/`A+` pair with a clear gap from `stop`; `stop` stays the last, visually distinct, one-tap action (no accidental stop).
- Seven steps: 50, 65, 80, 100, 115, 130, 150 %; default 100 %. Long-press either button resets to 100 %; `Ctrl/Cmd` `-`, `+`, `0` work on desktop; the buttons disable at the ends.
- Persisted per device in `localStorage` (`pixip.transcriptScale`), restored on load, clamped to the step list; missing or malformed values fall back to 100 %.
- Scaling is transcript-scoped: `#log` gets `font-size: calc(1rem * var(--transcript-scale))` and transcript text uses `em`; header, composer, footer, tool-card chrome and safe areas stay in px, and the root font size is untouched.
- Applying a size keeps the reading position (pinned bottom stays pinned; otherwise the distance from the bottom and the "load earlier" anchor stay), with no composer layout shift.
- `npm run check` green, including a pure helper test; the owner runs `tools/shot.mjs` at 360/390/1280 with 50 %, 100 % and 150 % (no horizontal overflow, stop reachable, composer unchanged).
- `docs/parity.md` marks transcript sizing done and `README.md` lists the control.

### Decisions (grilled 2026-11-21)

- Scope: transcript only. The composer deliberately stays 16 px (iOS zooms inputs below that).
- Storage: device-local `localStorage`; no hub state and no per-session record, so "all new sessions" is automatic and phone/desktop can differ.
- Control: header `A−`/`A+` (chosen over a sheet), placed after the title and before the connection dot/stop, with a 16 px+ gap and a distinct `stop` style; long-press either button resets; desktop shortcuts included; end states disabled with an accessible label.
- Range: the chosen 5-step idea extended down to 50 % as requested — seven steps 50/65/80/100/115/130/150 %.
- Technique: the rem-root approach would scale the composer too, so the transcript gets its own `em` scale through a CSS variable on `#log`; no `zoom`/`transform`; browser zoom still compounds on top.
- Layout: text-only scaling (glyphs + line-height); spacing, control sizes and safe-area insets stay px.
- Default 100 %, clamp on read, reset on long-press.

### Files

`src/client/index.html` (header buttons), `src/client/style.css` (`#log` scale, header layout), `src/client/transcriptScale.js` (new pure helper: steps, next/prev/clamp, storage parsing, labels), `src/client/app.js` (apply + wire buttons/keys), `test/transcriptScale.test.js`, `docs/parity.md`, `README.md`.

### Tests

- Pure: step order, clamp, next/prev at both ends, reset, parse null/garbage/out-of-range storage, label text.
- No DOM harness: owner screenshots at 360/390/1280 with 50/100/150, long-press reset, reload persistence, private window default, no horizontal overflow, stop still one tap away.
- Manual: change size with a long transcript and confirm the reading position (pinned and scrolled) does not jump.

### Notes

- Keep the control out of `#footer`; ticket `06-command-menu` moves the footer below the composer and must not move these buttons.
- Tool cards keep px padding/borders and scale only their text; check markdown tables/code blocks at 50 % and 150 % for overflow.
- Buttons stay 16 px themselves so 50 % does not make the control too small to tap.
- `aria-label` includes the current percentage; visible focus ring; long-press must not trigger a click as well.

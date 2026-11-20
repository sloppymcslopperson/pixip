The UI must be one responsive asset set: the phone layout has to be verifiable by resizing a desktop browser, and the same assets must serve an information-dense desktop view.

### Phone

- scroll stickiness and re-anchor after reconnect;
- composer height/growth, safe-area insets, keyboard overlap on iOS;
- block density and spacing at 390 pt width;
- tool output expand/collapse ergonomics with long ANSI output;
- whether `steer` should be surfaced as "queue" with visible depth.

### Desktop

- same page, same JS: no separate build, no user-agent branch, no mobile-only template;
- widening must add information (see the desktop surface ticket) rather than stretching one column to 1800 px;
- long lines should stop at a readable measure instead of running edge to edge;
- keyboard ergonomics: Enter sends, no chords required.

### How this gets verified

`tools/shot.mjs` renders any width in headless Chromium, prints the box model of header/list/log/composer, and flags horizontal overflow and console/page errors. Breakpoints to check: 360, 390, 768, 1280, 1600. A device is confirmation, not the only evidence.

### Already checked by rendering (2026-11-20)

Fixed after the first real renders: `hidden` was overridden by component `display` rules (list and composer both laid out while hidden, leaving 376 px of dead space above the transcript); user echoes escaped as literal HTML; thinking-only turns left an empty labelled block; assistant blocks were nested and double-labelled; a stray `ping` frame produced a toast. Reading measure is now capped (`104ch`) and the header aligns to it; the model is hidden from the subtitle below 560 px. Remaining phone work: iOS keyboard/safe-area behaviour under a real software keyboard, which no desktop resize can prove.

### Constraints

- CSS media/container queries only; no duplicated markup per breakpoint.
- Record which widths were checked when this ticket closes.

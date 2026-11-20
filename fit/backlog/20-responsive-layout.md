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

Resizing a desktop browser is the primary test path. Every layout change is checked at roughly 360, 390 (phone), 768 (tablet), 1280 and 1600 px, plus a coarse-pointer emulation pass for hover/`pointer: coarse` behaviour. No device is required to accept a change; a real phone is confirmation, not the only evidence.

### Constraints

- CSS media/container queries only; no duplicated markup per breakpoint.
- The responsiveness test is part of the change, so document what was checked in the ticket when it closes.

On desktop the app should show more than a single transcript column; the shape is undecided, with session cards as the leading candidate.

### Intent

Width is information budget. A phone shows one session; a 1440 px window should show the fleet, not one stretched column.

### Candidate directions (pick one before building)

- session cards on a desktop root view: title, cwd, state, last activity, last assistant line, open in one click;
- two-pane: session rail plus transcript, so switching does not lose scroll position;
- transcript plus a context side panel (files touched, tool summary, usage).

### Constraints

- Same assets and same JS as the phone view; responsive only (see the responsive-layout ticket).
- No second router and no desktop-only protocol; anything shown here must come from data the hub already streams (`status`, `snapshot`, `event`).
- Multi-session streams: decide whether the rail subscribes to every session's frames (costly, more live) or only to `status` (cheap, slightly stale). Measure before choosing.

### Open questions

- Does a card show a live tail of the transcript, or just state plus last message?
- Should the rail exist on tablets in portrait, or only above a width breakpoint?

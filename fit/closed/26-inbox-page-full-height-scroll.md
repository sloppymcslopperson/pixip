---
grilled: true
project: pixip
---

The inbox page clipped a long message at the bottom of the screen and left the rest blank, because `.inbox-list` was a nested 56dvh scroller whose flex children shrank to fit instead of overflowing. Make the list the page's only scroller and let it use the whole screen.

### Fix

- `#inbox-page` is a flex column with `overflow: hidden`; the toolbar is `flex: none` and `.inbox-list` takes `flex: 1; min-height: 0` with no `max-height`, so one scroller reaches the safe-area padded bottom edge.
- `.inbox-list > * { flex: 0 0 auto }`: cards are flex items, so without it they shrink to the list height and clip a long body instead of scrolling (the same trap `#log > *` documents).
- The page's bottom padding adds `--safe-b`, so the last card clears a phone's home indicator.

### Verification

- Puppeteer probe over the running daemon at 390x844 and 1280x800: list bottom lands on the viewport bottom (832/844, 788/800), the page itself does not scroll (`pageScrolls: false`), the list scrolls (`scrollHeight` 1731 vs `clientHeight` 687 at 390), and after scrolling to the end the last card is fully visible. No console/page errors.
- Real expanded message at 390 scrolls (`scrollTop` clamped at max) with the body no longer cut; 1280 keeps the 760px centered column.
- `npm run check` green.

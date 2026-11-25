# Mockup review: `paperape_brutal_mainscreen.svg`

What the mockup encodes, what its render gets wrong, and the open questions.
Numbers are measured from the SVG with `getBBox`, so they survive an Inkscape
edit that moves things around.

## Rendering it

Fonts first: `~/install_puppet_strings.sh` installs Noto Sans (variable) and
`chrome-headless-shell`. A fallback font changes every measurement below, so
check that the family actually resolves before trusting a render.

```bash
PIXIP_CHROME=... node tools/svg-review.mjs ui_work/mocks/paperape_brutal_mainscreen.svg \
  --out ui_work/mocks/review --widths 360,390 --crops all
node tools/svg-review.mjs ui_work/mocks/paperape_brutal_mainscreen.svg \
  --out ui_work/mocks/review --widths 1280 --crops none
```

`metrics.json` records the palette, type sizes and stroke widths; a new colour
or a new font size shows up there as a diff on one line.

## Rendered images

| Image | Shows |
| --- | --- |
| `review/…-360.png` | the mockup at its authored width |
| `review/…-390.png` | the same at a 390 phone width |
| `review/…-1280.png` | stretched to 1280 |
| `review/…-360-top.png` | wordmark bleed, the header disc |
| `review/…-360-banner.png` | the path label crossing the banner edge |
| `review/…-360-rows.png` | chips, action discs, `Stop` at 4.34 px |
| `review/…-360-footer.png` | message preview, envelope, count |

## What it encodes

| | |
| --- | --- |
| Canvas | 360 x 640, 1:1 viewBox |
| Palette | `#000000` ink (63 fills), `#e8ddcc` paper (41), `#ea3737` red (12); strokes: 8 paper, 4 ink |
| Type | Noto Sans only; 101.33 wordmark, 26.67 dir name, 22.82 `!`, 16 footer, 14.67 row title, 13.43 `Main`, 8 meta/stats, 6.61 badge `!`, 4.34 `Stop` |
| Grid | left gutter 40.05, text 57.60, right edge 344.62; banner 37.60..344.62 |
| Rows | 8 rows on a 30 px pitch; title box 20 tall, meta 8 px/11 tall at +19.4 |
| Chips | 13.55 x 24.78 at x 40.05, first at y 169.49; row 1's red chip is a path |
| Actions | discs r 12.39 at cx 307.45 and 332.23 (right edge 344.62), 24.78 pitch; row 8 has four: 257.89, 282.67, 307.45, 332.23 |
| Wordmark | baseline 54.65 in a band ending 55.41; bleed box x -8.79, 200.84 wide |

## Deliberate

- **Wordmark bleeds off the top and the left.** 101.33 px type with a 54.65
  baseline cuts **24.5% of the cap** (17.7 of 72.35) and 8.8 px off the left
  edge, with the baseline sitting on the band's bottom edge. Two edges and a
  deep cut is what makes it read as a crop instead of a clipping bug; keep both
  numbers if the band or the type size changes.
- Chips encode liveness as fill: rows 2–4 solid ink, rows 5–8 a black frame with
  a paper inset. Red chip + `!` is live attention; paper chip + ink `!` is cold
  attention.
- The header's list glyph runs past its disc to the artboard edge, echoing the
  wordmark bleed. Confirm this is wanted.

## Broken

1. **The path label is unreadable.** `~/dev/thing` and the dir name are one text
   node (box y 70.79–106.79) whose baseline sits on the banner's top edge
   (75.32). The path part is paper-on-paper above the banner and cut where it
   crosses the black, so it reads as a strikethrough. Split it into its own node
   and either put it fully above the banner in ink or fully inside it.
2. **`Stop` is 4.34 px** — a 10 x 7 box for four letters inside a 24.78 disc
   with a paper octagon. At 1x it is a smudge. Let the octagon carry the meaning
   and drop the word, or shrink the octagon and set the label at 7 px or more.
3. **Meta lines overrun the 30 px pitch by ~1 px** (meta box ends 165.02, next
   title starts 164.64). Either a 31 px pitch or a 9 px line-height for meta.
4. **Row 8 has two empty discs**, which read as disabled buttons. If the row is
   an overflow test, keep it; if it is meant to show real actions, fill them.
5. **The envelope badge is a 2 x 9 px `!`** — a filled dot (r 2.5) survives at
   1x where the glyph does not.
6. **`Idle| 24 Messages`** (three rows) is missing the space before the pipe.
   Fix the formatter, not the mock.
7. **The footer is fine** — text ends 253.3, envelope 266.5–307.6, count
   314.6–351.6. The overlap seen earlier was a fallback-font artifact.

## Source hygiene

- 3 layers (`Layer 2` background, `Layer 1` everything, `Layer 3` the action
  discs), still **no groups**: a row is 6–8 loose siblings.
- The same list glyph path is pasted **8 times** and the envelope twice. One
  `<symbol>`/`<use>` pair turns a glyph tweak into a single edit.
- 18 distinct `stroke-width` values (mostly transform scale factors) and 54
  inline `font-family` declarations; classes would collapse both.

## Open questions

- Row 8: overflow test or a real action set?
- Live attention (red + paper `!`) vs cold attention (paper + ink `!`) — is the
  colour shift the point, or should the glyph change shape instead?
- Does the `Stop` disc stay a word, or become the octagon alone?
- Is the header glyph's overshoot intended?

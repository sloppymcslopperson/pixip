# Mockup review: `paperape_brutal_mainscreen.svg`

Notes from rendering the mockup at 360/390/1280 and reading the file. Not a
ticket; a checklist while the design is still moving.

## Rendering it

```bash
LD_LIBRARY_PATH=/tmp/chromedeps/root/usr/lib/x86_64-linux-gnu \
PIXIP_CHROME=/tmp/pixip-chrome/chrome-headless-shell/linux-158.0.8127.36/chrome-headless-shell-linux64/chrome-headless-shell \
node tools/svg-review.mjs ui_work/mocks/paperape_brutal_mainscreen.svg --widths 360,390 --metrics
```

PNGs and `metrics.json` land in `tmp/svg-review/paperape_brutal_mainscreen/`.
Named crops (`top`, `banner`, `rows`, `footer`) are in SVG user units, so they
keep working if the artboard grows.

## What the file already encodes

| | |
| --- | --- |
| Canvas | 360 x 640, 1:1 viewBox |
| Palette | `#e8ddcc` paper (27 fills), `#000000` ink (96), `#ea3737` red (11) |
| Type | 9 sizes: 5.87, 8, 13.33, 13.43, 14.67, 16, 22.82, 26.67, 82.67; Noto Sans, weights 100/300/bold/900 |
| Rows | 30 px step; chips 13.55 x 24.78 at x=40.05; title x=57.6 |
| Right column | action cell 52.17 wide at x=289.42; icon cell 21.68 wide at x=319.91 (right edge 341.59) |
| Guides | x 24.05 / 30.58 / 40.05 / 53.60 / 57.60 / 289.42 / 322.66 / 341.59; y 55.4 / 87.3 / 99.4 / 110.8 / 116.7 / 145.5 / 170.3 |

Missing from `tokens.css`: space, type scale, stroke widths. Colours are done.

## Render defects

1. **Wordmark clipped.** Baseline 56.2 with 82.67 px type in a 55.4 px band puts
   cap tops at y=-2. Either band 62-66 tall or type 74 at baseline 52.
2. **Top-right chevron hangs below the band** onto the paper.
3. **`~/dev/thing` is cut by the banner notch** (same baseline as `some_work_dir`).
   Move it above the banner or pad it inside the notch.
4. **Footer overflows 360 px.** The preview runs through the envelope (x=266.5)
   and `9987` at x=316.8 is clipped. Preview needs a width budget with ellipsis
   (~190 px); count right-aligned at 360-13.3.
5. **`Stop` is 5.87 px** in a 52 x 24.8 cell. 8 px fits; 5.87 is a blur at 1x.
6. **Rows 3 and 4 have identical chips** (solid ink), so "finished" and "sent a
   message" differ only by the action cell.
7. **Row 6's `!` is 22.8 px in a 24.78 px outlined chip** and touches the border;
   row 2's `!` sits in a filled chip and reads better.

## Source hygiene (does not show in the render)

- 2 layers, **no groups**: 113 siblings, so nothing selects as a row.
- 14 distinct `stroke-width` values (2 on 88 elements); copy-paste residue.
- Sub-pixel drift: chips 24.780483/24.780487/24.780472, cells 52.171478 vs 21.676975.
- 3 id/type mismatches: `path` named `rect21`, `path` named `rect27`,
  `ellipse` named `path120`. All ids are Inkscape auto-names.
- Inline styles everywhere: 137 `fill`, 110 `stroke`, 116 `stroke-width`.
- Two text nodes glue separate fields via tspans
  (`~/dev/thing` + `/` + `some_work_dir`; `New Message!` + the preview quote).

## Open questions

- The SVG is behind the photos: no arch `sessions` tab, `Stop` is cream-on-black
  here vs red-outline in the photo, and there is no red overprint on the
  wordmark. Which artifact is authoritative?
- `some_work_dir` (underscores) vs "some work dir" (spaces) in the photo.
- Should "waiting for input" privilege an answer action over `Stop`?
- Rows 3/4: one chip or two states?

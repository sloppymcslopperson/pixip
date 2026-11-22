# Vendored A2UI renderer

`a2ui.esm.js` is a prebuilt browser bundle of the official A2UI v1.0 Lit
renderer. It is served as-is and lazy-imported by `src/client/a2ui.js` the first
time an `a2ui` panel arrives; nothing imports it at startup and there is no
runtime build step.

| Package | Version | License |
| --- | --- | --- |
| `@a2ui/web_core` | 0.15.0 | Apache-2.0 (`a2ui.LICENSE`) |
| `@a2ui/lit` | 0.15.0 | Apache-2.0 |
| `esbuild` (build only) | 0.25.12 | MIT |

Contents: `MessageProcessor`, the v1.0 Basic catalog
(`@a2ui/web_core/catalogs/basic/v1`, protocol `1.0`) with its universal custom
elements registered, `A2uiSurface` from `@a2ui/lit`, and
`injectBasicCatalogStyles`.

Measured: 486 KB minified, ~136 KB gzip. Page load does not fetch it.

## Rebuild

The A2UI packages are pinned in the root `devDependencies`; esbuild is fetched
by the script, so it is not a project dependency.

```bash
node tools/build-a2ui.mjs
```

The script rewrites `a2ui.esm.js` and `a2ui.LICENSE`, prints the pinned
versions, and must be followed by updating this file and the architecture note
if the versions changed. CI only reads the committed output; it never runs the
bundler.

## Security posture

Only catalog components are rendered. A2UI strings are never injected as HTML,
media URLs go through the catalog's sanitizer, and an unknown component type
produces a visible fallback card instead of a crash. Custom catalogs and
model-generated A2UI are out of scope.

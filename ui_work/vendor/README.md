# Vendored browser libraries for the UI mockups

These are unmodified upstream packages, copied here so the mockups in
`ui_work/` can be opened without a bundler, build step, or network access.

Only `README.md` (this file) is committed: the packages themselves are
generated and gitignored, because lit-html alone is 240+ files of upstream
code. After a fresh clone, run the fetch script once.

## lit-html

- Package: `lit-html` (standalone `lit-html` only — not the `lit` /
  LitElement web-components package)
- Version: 3.3.3
- Source: npm tarball `lit-html-3.3.3.tgz`
- Location: `ui_work/vendor/lit-html/` (gitignored)
- Copied: everything from the package except `node/` (the SSR/server build,
  which imports Node builtins and is not needed in the browser)

The browser build (`lit-html.js`, `directive.js`, `directive-helpers.js`,
`directives/*`, `development/*`) is dependency-free: all imports are relative
within this folder.

Fetch or refresh it with:

```bash
node tools/vendor-lit-html.mjs                 # the pinned version
node tools/vendor-lit-html.mjs --version 3.3.4 # try a bump, then pin it above
node tools/vendor-lit-html.mjs --help          # flags and defaults
```

The script pins the version in `tools/vendor-lit-html.mjs` (`LIT_HTML_VERSION`),
verifies the downloaded `package.json` matches, deletes and rewrites
`ui_work/vendor/lit-html/`, and prints the file count and size. It shells out to
`npm pack` and the system `tar`, so it needs network access and nothing else.
When the version changes, update `LIT_HTML_VERSION` and the version line above.

Equivalently, by hand:

```bash
npm pack lit-html@<version>
tar xzf lit-html-<version>.tgz
rsync -a --delete --exclude node package/ ui_work/vendor/lit-html/
```

Usage from a module in `ui_work/`:

```js
import { html, render } from "./vendor/lit-html/lit-html.js";
import { repeat } from "./vendor/lit-html/directives/repeat.js";
```

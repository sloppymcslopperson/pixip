---
project: pixip
grilled: true
---

### Implementation notes

- `tools/check-client-imports.mjs` parses `src/client` with `typescript` (`import`, `export ... from`, dynamic `import()`), skips `vendor/`, and keeps the cluster map in that file. It fails on cycles, any `app.js` import, cross-cluster feature imports, and non-`app.js`/`frames.js` modules importing a feature module.
- `test/check-client-imports.test.js` covers a synthetic static+dynamic cycle, cross-cluster import, non-feature import, same-cluster/kernel allowed edges, `app.js` import, and the real client passing.
- `check:imports` runs before `npm test` in `npm run check`. Verified the real graph (52 modules) passes and a temporary directory with a cycle plus `dashboard -> session` exits 1.
- `ARCHITECTURE.md` now documents the dependency rule, `app.js`/`frames.js` exceptions, configure callbacks, both tools, and the complete module map (dashboard/session/composer clusters, shared seams, configure, all client files). `README.md` gained the guard and `tools/` layout note.

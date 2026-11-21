---
grilled: true
---

Add a directory browser to choose the cwd for the next new session, so a phone user never has to type a path.

### Decisions

- Trigger: a `browse` button beside the existing free-text path input; the picker only fills the input and never creates the session itself.
- Transport: new REST endpoints `GET /api/dirs?path=` and `POST /api/dirs` (discovery only, matching `/api/sessions`); no new websocket frames.
- Root scope: browsing is restricted to `$HOME`; symlinks are resolved with `realpath` and rejected with 403 when they escape it.
- Start path: `defaultCwd` when it is inside `$HOME`, otherwise `$HOME`; accept absolute paths and `~`, treat relative paths as relative to `$HOME`.
- Navigation: list directories only, always hide dot-directories, parent row, clickable breadcrumb, filter box, and inline single-segment new-folder creation. Reject empty names, `/`, `\\`, `.`, `..` and leading dots.
- Ordering: directories whose child `.git` entry exists float first and get a small repo badge; otherwise case-insensitive alphabetical.
- Verification: `npm run check` plus `tools/shot.mjs` at 390 and 1280 for the dashboard and open picker.

### Scope

- Add pure path/listing helpers and tests for them.
- Add the REST handlers and server-side containment checks.
- Add the picker sheet, browse button and styles to the client.
- Update the REST list in `ARCHITECTURE.md` and the feature list in `README.md`.

### Acceptance

- The dashboard `new` form has a `browse` action that opens a sheet rooted at the smart start path.
- A user can navigate directories, filter the current list, create one folder, and tap "use this directory" to fill the path input.
- Dot-directories are never listed; repo roots sort first with a badge; escaping symlinks are not listed or entered.
- Invalid/missing/unreadable paths show an inline error, not a crash or a blank sheet.
- `npm run check` is green and both screenshot widths render without horizontal overflow.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check`: 203 tests pass, typecheck clean.
- `tools/shot.mjs` at 390×844 and 1280×900 for the dashboard: no page errors, no horizontal overflow; the picker sheet was opened in the same headless run (390 and 1280), navigated into a child, filtered to an empty result, and `use this directory` filled the new-session input.
- Creating a folder through the sheet was checked against a temporary `$HOME`; `POST /api/dirs` rejected traversal with 400 and a path outside home with 403.
- `fit_check`: 0 errors (one pre-existing short-name warning on a closed ticket).

---
grilled: true
---

Add agent-authored HTML reports to the pixip inbox. Reports live in hub-owned per-report directories, are edited only through a single `inbox_report` tool, are served safely at `/reports/<name>/`, and are attached to an inbox message by `reportName`. Deleting/evicting the last message that references a report removes its directory.

### Decisions (grilled 2026-11-26)

- **Tool surface:** one `inbox_report` tool with `action` = `new | write | add_asset | remove_asset | show`. Calling it with no arguments prints the tool help text. `show` returns the exact current HTML, asset filenames, attachment status and URL. No separate `inbox_report_show`, no `resume` action.
- **Create:** `new({name})` creates `<data-dir>/reports/<name>/`; it always fails if the name already exists. `write` works on drafts and on reports already attached to messages, so a report can be updated in place and referenced by follow-up messages.
- **Write conflict check:** if `index.html` already exists, `write` requires `existingHtml` with the exact current document; a mismatch fails and leaves the file untouched. The first write on a fresh draft omits `existingHtml`.
- **Agent-only:** no CLI report commands. The feature is exposed through `pixip-inbox` and the REST API only.
- **Files:** `<data-dir>/reports/<name>/index.html` plus top-level assets. The agent does not edit the directory directly; it writes HTML and adds/removes assets through the tool.
- **Assets:** `add_asset({name, path, filename?})` copies a local file into the report directory and returns just the top-level filename (e.g. `chart.png`) for embedding. Allowed types: PNG, JPEG, GIF, WebP, SVG, CSS, WOFF, WOFF2, TTF, OTF. Duplicate filename fails. `remove_asset` rejects removal while the current HTML or CSS still references the file.
- **Image policy:** local image/SVG assets over 1 MiB are rejected, matching `show_image_to_user`'s untouched-source limit. The agent should downscale or choose a smaller image.
- **Size caps:** `index.html` ≤ 1 MiB; each asset ≤ 1 MiB; whole report directory ≤ 10 MiB.
- **Safe HTML:** parse with `parse5` and enforce an allowlist of tags/attributes. No scripts, iframes, objects/embeds, frames, event handlers, `javascript:` URLs, meta refresh, base, external resources, root-relative references, or `..` escapes. `<a href>` external navigation links are allowed. Local `img`/`link`/CSS references use top-level asset filenames; small `data:image/png|jpeg|gif|webp` and `data:image/svg+xml` are allowed and SVG data is validated. Inline SVG is allowlisted too.
- **CSS:** inline `<style>` and `style` attributes are allowed after validation. CSS may use local `url()` references to allowed top-level assets and `data:` images; `@import`, external URLs and executable CSS constructs are rejected.
- **Forms:** form/input/button/select/textarea/etc markup is allowed for style demos, but `action`, `formaction`, `method`, `target`, and submit/reset/image button types are rejected. Forms are inert.
- **Serving:** `GET /reports/<name>/` serves `index.html`; `/reports/<name>` redirects to the trailing slash; `/reports/<name>/<asset>` serves top-level assets with the correct content type. No auth, matching the dashboard/client trust boundary. Response headers include a locked-down CSP, `nosniff`, `no-referrer`, and `no-store`.
- **Inbox integration:** messages gain an optional `reportName`; the card renders a `view report` action that opens `/reports/<name>/` in a new tab. Multiple messages may reference one report. Delete/cap eviction removes the report directory only when no remaining message references it. Unreferenced drafts older than 24 hours are swept.
- **Validation timing:** only when a tool submit changes content. There is no file watcher and no per-serve revalidation, because the report directory is hub-owned and not an editing surface. Safe response headers are still defense in depth.
- **Name rule (assumption):** safe slug of letters, digits, `-`, `_`, `.`; must start alphanumeric; max 64 characters. Reusing a name is allowed only after the report directory is gone.
- **Scope:** extension + hub + server route + client link + README/ARCHITECTURE. Add `parse5`. Browser evidence for the client link because this touches the dashboard.

### Acceptance

- Agent can create a report, write validated HTML, add a chart image, send a brief message with the report link, then rewrite the HTML with `existingHtml` and send a follow-up message.
- JavaScript, iframes, external image/CSS loads, root-relative loads, over-size reports, and stale `existingHtml` are rejected with actionable errors and leave the previous report state intact.
- A normal report renders at `/reports/<name>/` with local CSS/images/fonts; local form markup renders but cannot submit; the inbox card opens it in a new tab.
- Deleting the final referencing message deletes the report directory; deleting one of several referencing messages keeps it.
- `npm run check` is green and the client link is covered by browser evidence.

### Files likely touched

`src/inboxReport.ts` (new), `src/inbox.ts`, `src/hubInbox.ts`, `src/hub.ts`, `src/server.ts`, `src/client/inbox.js` (+ CSS), `extensions/pixip-inbox/src/{index,inbox}.ts`, tests, README, ARCHITECTURE, package.json/package-lock.

### Verification

- `npm run check` green with `PIXIP_CHROME` set and daemon/Pi session env unset (full root + all workspace checks). The inherited `PIXIP_INSIDE`/`PIXIP_DAEMON_URL` env makes the daemon lifecycle tests fail independently of this change; rerunning `test/daemon.test.ts` with that env removed passes.
- New `test/inboxReport.test.ts` covers the allowlist (scripts, frames, events, external/root/`..` loads, CSS `@import`, inert forms, inline SVG, data SVG), write conflict checks, asset add/remove, draft TTL/published cleanup, routes/CSP, multiple-message attachment and last-reference deletion.
- Extension tests cover `reportName`, REST forwarding, actionable errors and the no-argument help text.
- `tools/browser-check.mjs` now creates a report, asserts the `view report` link and opens the report in a new tab at 390px and 1280px; both viewports pass.
- Manual browser pass against an isolated daemon on port 8237: opened `/#inbox`, clicked `view report`, landed on `/reports/manual-check/`; title `Manual check`, heading `Manual report check`, inline SVG rendered.

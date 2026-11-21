---
grilled: true
---

Group sessions by cwd on the dashboard, collapsible and collapsed by default, keeping hot/warm sessions and the most recent session in each group visible even when collapsed.

### Decisions

- Hot = `busy` or `starting`; warm = `idle`; `stopped` and `error` are cold. Pinning is the union of every hot/warm session plus the single most recent session in the group (by `lastActivity`, descending), even if that newest one is cold.
- Group order follows the newest `lastActivity` in each group, descending; rows within a group are ordered by `lastActivity`, descending. Ties break by id for determinism.
- A collapsed header shows the home-shortened cwd, the session count, and the hidden count when non-zero (e.g. `~/dev/project  12 sessions · 5 hidden`). The expand/collapse affordance is only interactive when at least one row would actually be hidden; otherwise it is just a section label.
- Group labels are home-shortened (`/home/x/dev` -> `~/dev`) when the path is under `$HOME`; add `home` to `GET /api/info` and the `hello` frame so the dashboard can do this. Fall back to the full path when home is missing.
- Bucket by exact cwd with trailing slashes trimmed; blank/missing cwd becomes a single `unknown cwd` group. No symlink resolution or case folding.
- Each group header has a small `+` "new here" action that creates a session in that exact cwd without toggling the group; the existing cwd/new form stays at the top outside the groups.
- Per-row `cwd` lines are hidden inside groups, since the header owns the path.
- Header gear (dashboard only) opens a reusable settings sheet. First item: "Keep hot/warm and newest sessions visible when collapsed", default on, persisted per browser in localStorage. Turning it off means a collapsed group hides every row.
- Collapse state persists per browser in localStorage, keyed by the full cwd (new groups start collapsed; remembered open groups reopen). Missing/full localStorage falls back to in-memory state.
- Single-column grouped list at all widths (max ~760-1040 px); no multi-column/rail work, which stays in `backlog/25-desktop-surface`.
- Scope: client-only grouping plus the additive `home` discovery field; no hub-side grouping, no new session-list protocol, no auth/desktop changes.
- Verification: `npm run check` plus focused pure-helper tests; attempt `tools/shot.mjs` at 390/1280 and record a screenshot gap if Chromium is unavailable.
- Docs: update README and ARCHITECTURE where the dashboard or `hello` fields are described.

### Implementation

- `src/client/sessionGroups.js` (new, pure): exact-cwd bucketing with trailing-slash trimming and an `unknown cwd` fallback, activity ordering with deterministic ties, hot/warm classification, pinned-union collapse view, count labels, home-shortened labels, and collapse/pinning storage parsing.
- `src/client/app.js`: dashboard renders one section per cwd; default collapsed; persisted open states; hot/warm/newest pinning; header count + hidden count; `+` per group; toggle only when collapsing would hide a row; draft preservation for the top new-session form. Header gear is dashboard-only and opens a settings sheet with the pinning checkbox. `home`/`defaultCwd` are cached so list refreshes do not clear them.
- `src/client/index.html`, `src/client/style.css`: gear button, group header/toggle/`+`, settings-sheet row and hint; rows inside groups no longer repeat the cwd.
- `src/server.ts`, `src/wire.ts`: additive `home` on `GET /api/info` and the `hello` frame (`frameHello(sessions, defaultCwd, home)`); `WIRE_VERSION` stays 1.
- `test/sessionGroups.test.js` (new) plus a `frameHello` home assertion in `test/protocol.test.ts`.
- `README.md` and `ARCHITECTURE.md`: dashboard grouping/settings and the `hello` fields.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` green: typecheck plus 175/175 tests. A plain `npm run check` in this agent shell fails two pre-existing daemon tests because the parent exports `PIXIP_INSIDE=1`, which intentionally turns `pixip stop` into a restart.
- `node --check` green for `src/client/app.js`, `src/client/sessionGroups.js`, and `test/sessionGroups.test.js`.
- Screenshot gap: `/tmp/chrome-shell/.../chrome-headless-shell` is present but cannot launch (`libatk-1.0.so.0` missing, no installed Chromium libs and no sudo). `tools/shot.mjs` at 390/1280 with synthetic grouped sessions remains the owner's step.

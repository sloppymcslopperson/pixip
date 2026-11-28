# Press release deviation audit

Source: `docs/PRESS-RELEASE.md` (unedited draft).
Reality: `master` at `0ac7d2b`, FIT board 81 tickets.
Legend: **current** = runs on master; **in-ticket** = a ticket or branch exists;
**missing** = neither current nor ticketed; **wording** = true but overstated.

## Must fix: claims that are not true today

| PR claim | Today | Evidence | Fix |
| --- | --- | --- | --- |
| "available for free, right now, from NPM or Github" | Not published. `private: true`, no release workflow, no npm package. | `package.json`, no `.github/workflows` | "will be available" or publish first. |
| "just run the program ... and begin prompting" | Needs Node >= 22.19, `npm install`, a configured model provider, and (for the bundled tools) `pi install <path>` for the extensions. No published bin. | `package.json` engines; README install sections | State the prerequisites, or ship an installer/npx path. |
| "Windows, Mac, or Linux" | No CI matrix, no platform ticket, daemon uses `SIGTERM`/`SIGKILL` and POSIX-style signals. Unverified. | no `.github`; `src/daemon.ts` | Verify and ticket, or scope the claim. |
| "support for mobile notifications" | No notification code. Backlog is Web Push, blocked on HTTPS and PWA. | `backlog/90-web-push-notifications.md` | Remove, or say "in-app while a tab is open" if that is what ships. |
| "pair-programming ... X-Forwarded-User ... show who sent user messages" | No header parsing anywhere. Multiple clients can attach to one session; there is no attribution and no ticket. | `rg` finds `X-Forwarded-User` only in docs | Narrow to "multiple trusted devices can share a session"; ticket the header with proxy-trust rules. |
| "a single flag locks it down" | No lock-down flag. `--serious-mode` only serves the startup asset snapshot and disables the dev fixture; `/reload` and config edits remain available. | `bin/pixip.ts` help, `src/server.ts` `options.dev` | Implement a real lock flag, or drop the claim. |
| "extensive ... config.toml" | Current config is `pixip.json` for the command policy. The open ticket plans `pixip.toml` admin defaults (pending-UI timeouts), not an extensive config. | `open/60-options-toml-defaults.md` | Say "planned" and name the actual file/scope. |
| "streamlined agentic merge workflow" | Worktree create/join/list/remove exist. No merge command; `src/worktree.ts` only runs `merge-base` to detect merged branches. | README Worktrees; `src/worktree.ts:248` | Remove "merge workflow", or ticket it. |
| "bespoke A2UI implementation" | The renderer is vendored `@a2ui/lit` 0.15.0, fetched on first panel. Styling is still a backlog ticket. A first-party renderer is not ticketed. | `src/client/vendor/a2ui.esm.js`; `backlog/02-a2ui-styling.md` | Say "A2UI support" until the new renderer exists. |
| "built-in questionnaire tool" | `pixip-questionnaire` is a local-checkout, unpublished extension; the README tells you to `pi install` it. It is not a built-in factory. | README lines 59-72; `pi-host/src/runtime.ts` built-ins | Say "optional questionnaire extension", or bundle it. |
| "built-in mailbox to which agents can send" | The hub inbox is built-in. The agent side, `inbox_send`, is an opt-in local-checkout extension. | README Inbox; `extensions/pixip-inbox` | Split the claim: built-in mailbox, optional agent tool. |
| "sanitized, safe HTML reports" | Report hosting is on master: a hub-owned directory served at `/reports/<name>/` with HTML sanitized and no external loads. Creating one needs the opt-in `pixip-inbox` extension (`inbox_report`), so it is not built into the base install. | `src/inboxReport.ts`; `src/server.ts` reports route; `src/client/inbox.js:310`; `extensions/pixip-inbox` | Fine as "sanitized reports", but say the report tool is an optional extension. |
| "look great at any resolution ... access functionality ... actual hardware" | Current desktop is still one responsive column; a desktop surface is backlog. The new shell is an in-progress mockup. | `backlog/25-desktop-surface.md`, `backlog/20-responsive-layout.md` | Narrow to "phone-first and responsive" until desktop lands. |

## In-ticket, but not current

| Claim | Ticket | State |
| --- | --- | --- |
| Config file | `open/60-options-toml-defaults` | `pixip.toml`, admin defaults only. |
| Mobile notifications | `backlog/90-web-push-notifications` | Blocked on HTTPS + PWA; explicitly later. |
| A2UI styling | `backlog/02-a2ui-styling` | Panel styling still "looks odd". |
| Desktop surface | `backlog/25-desktop-surface` | Undecided shape. |
| Fresh-server install | `backlog/40-fresh-server-install-story` | Not designed yet. |
| Bind/auth documentation | `backlog/80-vpn-bind-and-auth-posture` | Posture is deliberate but undocumented. |

## True but needs qualification

- **"Bundles Pi"**: true. The default backend is `pixip-pi-host`, which depends on
  `@earendil-works/pi-coding-agent` 1.5.2. But a fresh user still needs provider
  auth before the first prompt, and the pinned SDK is a version-skew risk for
  extensions. There is no version display or supported-range check.
- **"No network security or access models"**: not absolute. `--inbox-token`
  enables a Bearer check on the inbox API, and `POST /api/refresh` is
  loopback-only. They are narrow and not user auth, but the sentence is false as
  written.
- **"No special permissions"**: true; no root. It does `chmod 0700` on its own
  directories.
- **"Only accepts inbound connections via the exact parameters"**: true for the
  bind address and port.
- **"Wrapped in Docker/MicroVM/VPS without loss"**: plausible, not proven. A
  container needs the repo/workspace layout, `node_modules`, and mounts for
  sessions and worktrees.
- **"Instant device handoffs"**: multiple clients share the session; there is no
  explicit handoff mechanism. Broadcast is real.
- **"Server down ... resume where it left off"**: sessions resume from JSONL, but
  an in-flight turn is lost. Say "resume from the last completed record".
- **"Hot reload ... immediately"**: real (`/reload`, `--watch`), but `/reload`
  refuses while busy and `--watch` is opt-in with a 200 ms debounce and a gate.
- **"Endpoints ... thoroughly documented"**: partly. README covers inbox, and
  ARCHITECTURE covers the socket and refresh; there is no complete route
  reference.

## Accurate as written

- Bundled Pi by default; system Pi is the explicit `--use-system-pi` opt-in, and
  both read the same `~/.pi` config, extensions and providers.
- Worktree creation, join, list, remove and prune.
- Built-in inbox hub, dashboard bar and `#inbox` page.
- Hot reload: `/reload` swaps assets, policy and daemon code; `--watch` watches
  `src/` and `extensions/`.
- Reconnect with backoff, cursor resume and parked sockets.
- Multi-device broadcast.
- No sandbox, no root, explicit bind parameters.
- "Developed in PixiP".

## Mechanical fixes

- `It a` → `It is a`; `better then` → `better than`; `used safety` → `used
  safely`; `sand defaults` → `sane defaults`.
- `network security of access models` → `network security or access models`.
- `Pixip` → `PixiP`; `Github` → `GitHub`; `NPM` → `npm`.
- The multi-device paragraph ends mid-sentence at "and".
- "safe HTML reports": say how (allowlist + locked-down CSP), and only after the
  report branch merges.
- "pair-programming" is unqualified; add "trusted collaborators" and the proxy
  stripping rule for `X-Forwarded-User` if the claim stays.

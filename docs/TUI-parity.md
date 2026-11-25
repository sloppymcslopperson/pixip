# TUI parity

pixip is meant to replace AoE for Pi sessions, and the next leg exists because the
owner wants to develop pixip **inside pixip**. This page is the coverage map: every
Pi TUI command and composer behaviour, where pixip stands, and which ticket owns
the gap. The board tickets remain the work units; this table is the source of
truth for "can I stop using the terminal yet".

Statuses: **done** · **`NN-ticket`** (planned/in progress) · **TUI-only** (no RPC
surface, deliberately not ported; pixip shows a local notice instead of sending it
to the model).

## The dogfooding leg

| Order | Ticket                | What it unlocks                                                                                                         |
| ----- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1     | `00-prefix-commands`  | done: `/`, `!`, `!!` classification, bash, command policy, prompt/steer dispatch                                        |
| 2     | `01-daemon-refresh`   | done: run pixip as a background daemon; soft reload and `--when-idle` restart so the agent can update pixip mid-session |
| 3     | `02-builtin-commands` | done: `/compact`, `/name`, `/session`, `/copy`, `/model`, `/thinking`, `/new`, `/resume`, `/quit`                       |
| 4     | `06-command-menu`     | done: `/` suggestion menu and the status line below the composer                                                        |
| 5     | `07-queue-display`    | done: visible steering/follow-up queue with clear/restore                                                               |
| 6     | `08-session-commands` | done: `/tree`, `/fork`, `/clone`, `/import`, `/export`; in-place leaf navigation stays TUI-only                         |

After the leg, the first ticket pixip worked on itself is
`03-add-font-size-control` (transcript text sizing): a small, self-contained UI
slice used as the test of the dogfooding setup. It is done; everything else below
is either already done or deliberately deferred.

## Commands

| Command                   | TUI behaviour                           | pixip                                                                                                                                                                                          |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings`               | settings selector                       | TUI-only                                                                                                                                                                                       |
| `/model [provider/model]` | picker, or set directly                 | done (`02-builtin-commands`: sheet or exact/suffix match)                                                                                                                                      |
| `/thinking [level]`       | picker, or set directly                 | done (`02-builtin-commands`: sheet or exact/prefix match)                                                                                                                                      |
| `/scoped-models`          | configure interactive cycling           | TUI-only                                                                                                                                                                                       |
| `/login`, `/logout`       | OAuth/API-key flows                     | TUI-only (run `pi login` once in a terminal)                                                                                                                                                   |
| `/llama`                  | llama.cpp router management             | TUI-only                                                                                                                                                                                       |
| `/new`                    | fresh session in the same child         | done (`02-builtin-commands`: re-key + resnapshot)                                                                                                                                              |
| `/resume`                 | session picker                          | done (`02-builtin-commands`: returns to the session list)                                                                                                                                      |
| `/name [name]`            | show/set session name                   | done (`02-builtin-commands`)                                                                                                                                                                   |
| `/session`                | session id/file/stats                   | done (`02-builtin-commands`: meta sheet)                                                                                                                                                       |
| `/tree`                   | navigate the session tree in place      | done (`08-session-commands`: read-only sheet with labels, current branch, per-user-message fork/copy; **in-place leaf navigation is TUI-only** because RPC `get_tree` has no navigate command) |
| `/fork`                   | pick a user message, fork a new session | done (`08-session-commands`: tap the fork affordance on a user block, or `/fork <entryId>` / the tree sheet; re-key + resnapshot)                                                              |
| `/clone`                  | duplicate the current branch            | done (`08-session-commands`: re-key + resnapshot, cancellation is a toast)                                                                                                                     |
| `/compact [instructions]` | compact context                         | done (`02-builtin-commands`: plus a transcript resnapshot)                                                                                                                                     |
| `/import <path>`          | import a JSONL                          | done (`08-session-commands`: copies into `<data-dir>/sessions/`, indexes it, switches to it)                                                                                                   |
| `/copy`                   | copy last assistant message             | done (`02-builtin-commands`: clipboard, sheet fallback)                                                                                                                                        |
| `/export [path]`          | export HTML/JSONL                       | done (`08-session-commands`: `export_html` under `<data-dir>/exports/` plus the JSONL, both as HTTP attachments)                                                                               |
| `/share`                  | upload and return a viewer link         | TUI-only                                                                                                                                                                                       |
| `/trust`                  | save a project trust decision           | TUI-only                                                                                                                                                                                       |
| `/mcp`                    | MCP server management                   | TUI-only                                                                                                                                                                                       |
| `/reload`                 | reload Pi resources                     | TUI-only (the header `reload`/`pixip refresh` soft-refreshes pixip's assets/config/index, not Pi's resources)                                                                                  |
| `/hotkeys`                | keybinding help                         | TUI-only (web keyboard is different)                                                                                                                                                           |
| `/changelog`              | changelog viewer                        | TUI-only                                                                                                                                                                                       |
| `/quit`                   | quit Pi                                 | done (`02-builtin-commands`: soft quit, detach + session list)                                                                                                                                 |
| `/debug`                  | debug view                              | TUI-only                                                                                                                                                                                       |
| `/extension`              | extension commands, e.g. `/fit`         | done (`00-prefix-commands`: passthrough to Pi)                                                                                                                                                 |
| `/template`               | prompt templates                        | done (`00-prefix-commands`: passthrough to Pi)                                                                                                                                                 |
| `/skill:name`             | skills                                  | done (`00-prefix-commands`: passthrough to Pi)                                                                                                                                                 |
| unknown `/thing`          | sent as a prompt                        | done (`00-prefix-commands`: same passthrough)                                                                                                                                                  |

## Composer and runtime

| Behaviour                                         | pixip                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `!cmd`, `!!cmd` (bash, excluded from context)     | done (`00-prefix-commands`: streamed card, `!!` badge)                                                                                                                                                                                                       |
| Command menu on `/`                               | done (`06-command-menu`: filtered static + `get_commands` rows, prefix-first, TUI-only dimmed, footer below the composer)                                                                                                                                    |
| Steering/follow-up queue visible, clear + restore | done (`07-queue-display`: chips from `queue_update`, X clears and restores both lists into the composer)                                                                                                                                                     |
| Abort a running bash                              | deferred (gap; TUI-only for now)                                                                                                                                                                                                                             |
| Input history (up/down)                           | deferred                                                                                                                                                                                                                                                     |
| `@file` completion                                | deferred                                                                                                                                                                                                                                                     |
| Image paste/attachments                           | done (`00-web-image-upload`: `+` menu for photo/camera or arbitrary file, clipboard paste, one removable preview; images travel as Pi `ImageContent`, other files upload to `<data-dir>/uploads/<logical-session>/` and the prompt gets their absolute path) |
| Agent shows an image                              | done (`00-agent-show-image`: `show_image_to_user` extension, thumbnail on the tool card, text folded below, tap to enlarge; over 1 MB downscaled, over 20 MB link only)                                                                                      |
| Esc to abort/clear                                | abort via the stop button; queue clear via the X on the chips (`07-queue-display`)                                                                                                                                                                           |
| Long `notify` text readable (extension commands)  | done (`00-prefix-commands`: dismissible sheet, not a 3.2 s toast)                                                                                                                                                                                            |
| Transcript text size (50–150 %, header `A−`/`A+`) | done (`03-add-font-size-control`: seven steps, device-local, transcript-only, long-press reset)                                                                                                                                                              |
| Working / compacting status                       | done (footer + toasts)                                                                                                                                                                                                                                       |
| Markdown rendering                                | done (`00-render-markdown`)                                                                                                                                                                                                                                  |
| Diff/syntax colouring and TUI theme values        | `85-theme-tokens`                                                                                                                                                                                                                                            |
| TUI status line                                   | done (`16-tui-status-line`)                                                                                                                                                                                                                                  |
| Full transcript (not just windows)                | `10-expand-full-transcript`                                                                                                                                                                                                                                  |
| Desktop multi-session surface                     | `25-desktop-surface`                                                                                                                                                                                                                                         |
| Responsive layout contract                        | `20-responsive-layout`                                                                                                                                                                                                                                       |
| Worktree create/teardown (AoE parity)             | done (`06-worktree-create-join`, `07-worktree-dashboard`, `08-worktree-cli-docs`: create/join, dashboard delete, CLI list/remove/prune, docs)                                                                                                                |
| Auth posture / VPN bind                           | `80-vpn-bind-and-auth-posture`                                                                                                                                                                                                                               |

## pixip-only behaviour (no TUI equivalent)

- stable pixip logical session ids (`PIXIP_SESSION_ID`) across Pi session ids
  (`03-session-index-empty`);
- durable entry-cursor reconnect, so a phone that drops mid-turn misses nothing
  (`04-snapshot-live-cursor`);
- index-only sessions keep their name and listing after detach (`03`);
- daemon lifecycle + soft refresh (`01-daemon-refresh`, done);
- per-project command policy (below).

## Command policy

Commands can be whitelisted or blacklisted, at command-name granularity, in three
restrict-only layers (a more specific layer can only narrow):

1. `<data-dir>/pixip.json`;
2. `<session-cwd>/.pixip.json`;
3. CLI: `--allow-command <name>` (repeatable), `--deny-command <name>`, `--no-bash`.

```json
{
	"commands": {
		"allow": ["compact", "name", "model"],
		"deny": ["login"],
		"bash": true
	}
}
```

`deny` wins over `allow`; an empty `allow` list means "no allow restriction";
`bash: false` disables `!`/`!!`. Names are bare (`compact`, not `/compact`). Denied
and TUI-only commands render a local notice and are never sent to the model. The
effective policy is resolved per session from its cwd and sent to the client.

Implemented in `00-prefix-commands` (`src/commands.ts` reads and validates, the pure
`src/client/commands.js` merges, the hub sends a `policy` frame per session, and
the composer applies it to built-ins, TUI-only commands and passthrough alike).
`01-daemon-refresh` re-resolves it on a soft refresh.

## Extension commands (e.g. `/fit`)

pixip has no FIT-specific code or dependency. `/fit` is a Pi extension command
registered by the `FIT_pi` package, so it rides the generic extension-command path:
the composer forwards the literal slash text to Pi's `prompt`, Pi executes it, and
its dialogs/notify come back over `extension_ui_request`. Three generic
guarantees make that usable (implemented in `00-prefix-commands`):

- slash input while busy uses `prompt` + `streamingBehavior: "steer"`, because RPC
  `steer` does not execute extension commands; plain text uses the same command
  for the same reason, plus RPC `steer` would queue forever if it arrived while
  Pi was idle (it never starts a turn);
- `prompt` is not subject to the hub's 20 s command timeout, because extension
  handlers block on user dialogs (`/fit edit`, `/fit work`);
- long/multi-line `notify` text (e.g. `/fit help`) opens a dismissible sheet
  instead of a timed toast.

The command policy can allow/deny `fit` by name like any other command; it is not
in the built-in or TUI-only catalog.

## Extension panels and questionnaires

Blocking `panel` requests render in the inline surface between `#log` and the
composer. The panel host (`03-panel-host`) knows nothing about A2UI: a renderer
registers a mount function, and the host owns the frame, collapse/expand,
queue/Replace and draft replay. `04-a2ui-panel-renderer` registers the A2UI v1.0
adapter; its vendored bundle is fetched only for the first A2UI panel.

| Surface                                    | pixip                                                    | TUI parity                                                                         |
| ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A2UI panel (`03`, `04`)                    | done: collapsible inline panel, lazy bundle, action JSON | TUI-only: no inline panel                                                          |
| `questionnaire` (`05-pixip-questionnaire`) | done: A2UI inline panel with choice/text widgets         | same tool renders with `ctx.ui.custom`; other RPC/ACP hosts use sequential dialogs |

Fallback order is **A2UI inline panel → TUI custom UI → sequential dialogs**. The
panel path needs `--pi-host`; the legacy `pi --mode rpc` backend has no `panel`
and therefore uses dialogs even in pixip. On hosts that cannot collect typed
text (stock `pi-acp`), the free-form row becomes "Answer this in chat" and
multi-select gets "Add an item in chat" instead of a dead-end text prompt.

The new package is local-checkout only and unpublished. `pi_questionare` is
**not removed automatically** and stays the documented fallback until you remove
it yourself; install `pixip-questionnaire`, try it in a pixip session, then
`pi list` and `pi remove` the old source. A2UI answers are not persisted in the
session transcript; only a pending panel is replayed from the hub's cache.

## Checking a slice

Definition of done is unchanged: `npm run check` green, plus `tools/shot.mjs` at
390 and 1280 for client work (the current CI box has no Chromium, so the owner
runs the screenshots). Update the affected rows here and in `README.md` when a
slice closes; add new tickets as rows rather than editing statuses in prose.

# Session control

Session control is everything that changes what a session *is* rather than how its transcript reads: which model and thinking level it uses, the name it carries, and the Pi session id it points at. The footer is the always-visible instrument panel for those facts, and one tap on it opens the only per-session picker. Renaming, titling, tree/fork/clone/import/export, copy and compaction are the operations that move identity, history or context; new and resume move the user between sessions.

## Contents

- [User stories](#user-stories)
- [The footer](#the-footer)
- [Model and thinking level](#model-and-thinking-level)
- [Renaming and first-prompt titles](#renaming-and-first-prompt-titles)
- [Copying the last answer](#copying-the-last-answer)
- [The session tree, fork and clone](#the-session-tree-fork-and-clone)
- [Import and export](#import-and-export)
- [New, resume and stop](#new-resume-and-stop)
- [Compaction](#compaction)
- [What a control changes](#what-a-control-changes)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want to switch the model or thinking level for this session only, from the footer.
- As a user, I want pwd, branch, name, tokens, cost, context usage and `model • thinking` visible while I read.
- As a user, I want a short name from my first prompt, and my own rename to win, even after a stop.
- As a user, I want to copy the agent's last answer, browse the session tree, and fork or clone without losing the original.
- As a user, I want to import a session file and export the current one in a format I can keep.
- As a user, I want to compact a long session and understand what happened to the old history and context window.
- As a user, I want `/new` for a clean session and `/resume` for the list, while a stopped session stays named and recoverable.

## The footer

The footer sits below the composer inside the sticky bottom dock, visible in every open session. It has two lines, fed as raw numbers by the hub and formatted by one pure client module so it reads like Pi's TUI footer.

Line one is `~/cwd (branch) • session name`, home shortened to `~`, branch in parentheses only when git reports one, and no separator while unnamed. It matches the header and dashboard name.

Line two carries usage. Left: `↑input ↓output R<cacheRead> W<cacheWrite>`, then `$cost` to three decimals when nonzero, then context usage. Zeros are omitted, so a fresh session shows only `?/window (auto)`. Usage is `percent%/window`, with `?/window` when Pi cannot compute a percentage and `(auto)` when auto-compaction is on; warning above 70 %, error above 90 %. Right: `model • thinkingLevel` when the model reports reasoning, `model` alone otherwise, `no-model` as fallback, and `thinking off` rather than a bare `off`.

Tapping the footer opens the session sheet with the current model and thinking level, each row opening its picker; it never sends anything to the model.

A child mid-shutdown may send no footer, and the last painted one stays. A model change, thinking change, compaction end or settled turn re-sends the whole footer, so numbers cannot drift. The git branch is cached per session, so a branch switched outside pixip appears on the next attach.

## Model and thinking level

Both are per-session and share one path: RPC passthroughs to the running Pi child. The picker lists what Pi says is available — `get_available_models` for the model sheet and `get_available_thinking_levels` for levels — with a checkmark on the current entry. Choosing one sends `set_model` with provider and id, or `set_thinking_level`, closes the sheet, and updates the footer.

Typed forms exist for people who know what they want. `/model <provider/model>` resolves exact `provider/id`, then exact id, then a unique id or provider suffix. `/thinking <level>` tries an exact match, then a unique prefix. Ambiguous and unknown queries are refused with the closest matches named, never silently guessed. An empty command opens the picker.

A change applies to this session only; it writes no global default. A thinking change made by the agent arrives as `thinking_level_changed` and refreshes the footer. A model change updates the header subtitle, so the two never disagree. An empty model list reads `no models configured`, an empty level list `no levels reported`; a title-model override that no longer resolves falls back to the session model.

## Renaming and first-prompt titles

`/name <text>` sets the name; bare `/name` toasts the current name or `(unnamed)`. A rename is stored in Pi via `set_session_name`, appears in the header, footer, dashboard row and browser tab, and is written to the index as `nameSource: "manual"`. Because the disk scan reads the JSONL header and first and last name records, a stopped session keeps it.

First-prompt titling is automatic and one-shot. When a session has no name, no user messages and receives its first prompt, the hub starts a short-lived `pi --print` child with tools, extensions, skills, prompt templates, context files and MCP disabled, and asks for a 3–5 word sentence-case label. It runs beside the prompt, never on its critical path.

A slash-command prompt is not labelled from its alias: the hub waits for Pi's expanded first user message, so `/fit work 5` is named for the ticket. The title prompt ignores process boilerplate and asks for the concrete feature, bug, file or decision. The reply is normalized to the first useful line, markdown noise stripped, five words and 40 characters maximum, sentence case.

The local fallback guarantees a name. If the call fails, times out, returns nothing, or loses the provider race to the first turn, the hub retries once at `agent_settled`, then derives a label from the prompt, preferring an explicit `title:` field over the first meaningful words.

Precedence is strict: a name present at first prompt skips titling, a manual rename always wins, an auto label never overwrites another, and an auto label is never applied over a name that appeared while the call ran. `--title-model` / `PIXIP_TITLE_MODEL` chooses the naming model, otherwise the session model. Auto names are `nameSource: "auto"`, so a guess is distinguishable from a decision. A session named after its first paragraph is the visible fallback when both the model call and fallback lack meaningful text; it stays editable.

## Copying the last answer

`/copy` writes Pi's last assistant message to the clipboard. Without a clipboard API — an http LAN origin on a phone, for example — a sheet opens with the exact text, pre-selected so one browser gesture can copy it, plus a `copy` button. An empty answer toasts `nothing to copy` instead of clearing the clipboard. The transcript's per-message copy affordances and ref tags belong to the transcript and refs areas; this control is the fast path that needs no scrolling.

## The session tree, fork and clone

`/tree` fetches Pi's read-only tree into a sheet: every entry is one indented row in tree order, a role label (`you`, `pi`, `tool`, `bash`, `compaction`, `branch summary`), an optional Pi label, the text, and a `current` mark on the tip. Entries on the path to the current leaf are the current branch; other branches stay visible but dimmer. The header counts entries; an empty tree says `no entries yet`.

User rows carry `fork from here` and `copy prompt`. Forking closes the sheet and runs the fork; copying writes that prompt to the clipboard. `/fork <entryId>` does the same without the tree, and bare `/fork` opens it to pick a row. A fork affordance on a transcript user block is another entry point.

`/clone` duplicates the current branch. Both create a new Pi session in the same child, then the hub re-reads `get_state`, re-keys and tells every tab to adopt a replacement window. The result is a toast (`forked`, `forked: <text>`, `cloned`) or `fork cancelled`; cancellation is an extension declining, not an error.

The limit is explicit: the tree is **read-only navigation**. Pi's RPC `get_tree` has no switch-leaf verb, so in-place navigation stays TUI-only, and pixip offers fork instead of pretending to move the pointer. Forking a mid-history row gives the wanted branch without mutating the branch the user was on.

## Import and export

`/import <path>` takes a Pi JSONL file, resolved against the session's cwd. The hub validates the header, rejects separators and traversal in the id so a foreign file cannot write outside the sessions directory, copies it into `<data-dir>/sessions/` under its original timestamp and id unless it is already that file, indexes cwd/repo/worktree, then switches the live child and re-keys. A non-JSONL file fails naming the path; an attached id is refused; a cancelled import leaves the current session untouched.

`/export` opens a sheet with `download HTML` and `download JSONL`, plus `downloads only · nothing is sent to the model`. HTML is written under `<data-dir>/exports/` by Pi's exporter; JSONL is the session file itself, unmodified. Both are served as attachments with `no-store`, and filenames come from the session name plus a short id, never the raw path. The JSONL link is absent when Pi has no file yet. Exporting never changes the session or its context.

## New, resume and stop

`/new` starts a fresh Pi session in the same live child: `new_session`, clear that logical session's uploads, re-key, and every tab adopts a replacement window with the old history gone. `/resume` returns to the dashboard by clearing the route; `/quit` detaches and returns to the list.

Stop and wake belong to the dashboard and header; here, a stop keeps the JSONL and the name, and a wake reattaches to that file. Archived-session identity and id reuse is a separate open concern (`06-archive-session-identity`).

## Compaction

`/compact [instructions]` asks Pi to compact, optionally with custom instructions. While it runs, the transcript shows a persistent `compacting context (<reason>)… Ns` row with elapsed time, the composer locks, and the draft is kept. Automatic threshold or overflow compaction takes the same path and is labelled by its reason.

On success the client requests a replacement snapshot. Old windows are dropped and repainted from Pi's compacted state, with a collapsed boundary at the compaction entry: summary, tokens before and after when known, duration and time. The full history is still readable behind that boundary — compaction changes the model's context and the session file's shape, not the user's ability to read what happened. The footer refreshes. A failed compaction toasts `compaction failed: …`, adds no boundary, and changes no history.

Automatic compaction shows `(auto)` in the footer; the agent may compact mid-turn, and the same refresh applies with no request. The replacement frame invalidates pre-compaction windows, so old and new context never mix.

Cancelling a running compaction is **not shipped**. The `abort` frame exists and Pi supports aborting, but no client control sends it, so the only exit is waiting or stopping. `10-cancel-compaction` records the desired state: a cancel control on the status block; manual idle compaction returns to the unchanged transcript as though `/compact` was never called, while threshold/overflow cancellation also aborts the turn (Pi has no compaction-only verb) and must say so. Until it lands, no cancel affordance is described here.

## What a control changes

Three families behave differently, and that difference is what a user should expect.

A **configuration** change (model, thinking) mutates the live child and the footer, leaves history and identity alone, and lasts only as long as the session runs. A **naming** change (manual or auto) mutates Pi's session name and the index, appears wherever the session is listed, and survives a stop. An **identity** change (`/new`, fork, clone, import) creates or switches to another Pi session, re-keys, and replaces the transcript window; the old file remains on disk and reachable from the dashboard.

A **transform** (`/compact`) rewrites the working context and paints a boundary but leaves id and name alone. A **move** (`/resume`, `/quit`, stop) leaves session state as it was and changes only the browser's view.

## Wireframes

### Footer anatomy and the session sheet

```svg
<svg viewBox="0 0 360 260" width="100%" style="max-width:400px" role="img" aria-labelledby="wf80-footer">
  <title id="wf80-footer">Session footer: pwd, branch and name; tokens, cost, context and model line; tap opens the session sheet</title>
  <rect x="1" y="1" width="358" height="258" rx="12" fill="none" stroke="#888"/>
  <text x="16" y="24" font-size="11" fill="currentColor">fix transcript scroll</text>
  <text x="16" y="38" font-size="8" fill="#777">idle · deepseek-v4.1-flash · high · 18 msg</text>
  <rect x="10" y="52" width="340" height="120" rx="7" fill="none" stroke="#888"/>
  <text x="24" y="74" font-size="9" fill="#777">you · branch or task summary…</text>
  <text x="24" y="96" font-size="9" fill="#777">pi · the load-earlier anchor now keeps its place</text>
  <text x="24" y="118" font-size="9" fill="#777">tool · read transcriptScroll.js</text>
  <text x="24" y="150" font-size="8" fill="#6f6889">transcript scrolls behind the dock</text>
  <rect x="0" y="184" width="360" height="76" fill="#16141f" stroke="#322b45"/>
  <rect x="8" y="190" width="344" height="20" rx="5" fill="none" stroke="#7aa2f7" stroke-dasharray="3 3"/>
  <text x="14" y="204" font-size="8" fill="#7aa2f7">1  ~/dev/sin/pixip (main) • fix transcript scroll</text>
  <rect x="8" y="214" width="344" height="20" rx="5" fill="none" stroke="#7aa2f7" stroke-dasharray="3 3"/>
  <text x="14" y="228" font-size="8" fill="#e7e3f2">2  ↑12.4k ↓3.1k R88k W4.2k $0.184  31.2%/128k (auto)</text>
  <text x="278" y="228" font-size="8" fill="#e7e3f2">flash • high</text>
  <text x="14" y="250" font-size="8" fill="#6f6889">tap anywhere on the footer → session sheet → model / thinking picker</text>

  <rect x="230" y="52" width="120" height="120" rx="8" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="240" y="70" font-size="9" fill="#e7e3f2">session</text>
  <text x="240" y="90" font-size="8" fill="#cfc9e0">model: flash</text>
  <text x="240" y="106" font-size="8" fill="#cfc9e0">thinking: high</text>
  <text x="240" y="122" font-size="8" fill="#6f6889">tap a row to pick</text>
  <rect x="240" y="134" width="100" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="248" y="146" font-size="8" fill="#e7e3f2">✓ deepseek…flash</text>
  <rect x="240" y="156" width="100" height="16" rx="4" fill="none" stroke="#888"/>
  <text x="248" y="167" font-size="8" fill="#e7e3f2">✓ high</text>
</svg>
```

### Rename versus auto title

```svg
<svg viewBox="0 0 720 300" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf80-name">
  <title id="wf80-name">Decision flow: first prompt, auto title child, fallback, manual rename always wins</title>
  <rect x="4" y="4" width="712" height="292" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">A NAME HAS ONE OWNER</text>
  <rect x="18" y="42" width="150" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">first prompt</text>
  <text x="26" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">0 messages · no name</text>
  <line x1="168" y1="65" x2="196" y2="65" stroke="#6f6889"/>
  <rect x="196" y="42" width="176" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="204" y="60" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">one-shot title child</text>
  <text x="204" y="74" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">beside the turn · no tools</text>
  <line x1="372" y1="65" x2="400" y2="65" stroke="#6f6889"/>
  <circle cx="424" cy="65" r="22" fill="#241f33" stroke="#bb9af7"/>
  <text x="418" y="69" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">?</text>
  <line x1="446" y1="59" x2="486" y2="42" stroke="#6f6889"/>
  <line x1="446" y1="71" x2="486" y2="90" stroke="#6f6889"/>
  <rect x="486" y="22" width="212" height="42" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="494" y="40" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">3–5 words, sentence case</text>
  <text x="494" y="54" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">slash prompt waits for the expanded message</text>
  <rect x="486" y="74" width="212" height="46" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="494" y="92" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">retry once · local fallback</text>
  <text x="494" y="106" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">title: field, else first words</text>

  <line x1="20" y1="132" x2="700" y2="132" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="20" y="154" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">PRECEDENCE</text>
  <rect x="20" y="168" width="196" height="50" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="186" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">name already present</text>
  <text x="28" y="200" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">skip the title call entirely</text>
  <rect x="228" y="168" width="196" height="50" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="236" y="186" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">/name typed while it runs</text>
  <text x="236" y="200" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">manual rename wins; auto is dropped</text>
  <rect x="436" y="168" width="262" height="50" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="444" y="186" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">stopped session</text>
  <text x="444" y="200" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">name survives in the JSONL and the index</text>
  <text x="20" y="242" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">nameSource is recorded as "auto" or "manual", so a guess is never mistaken for a decision.</text>
  <text x="20" y="260" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">--title-model / PIXIP_TITLE_MODEL chooses the naming model; an unresolvable override falls back</text>
  <text x="20" y="278" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">to the session model. Titling never waits on the first prompt or adds to model context.</text>
</svg>
```

### Tree, fork and clone

```svg
<svg viewBox="0 0 360 420" width="100%" style="max-width:400px" role="img" aria-labelledby="wf80-tree">
  <title id="wf80-tree">Read-only session tree with indentation, current branch, leaf mark, and fork/copy actions on user rows</title>
  <rect x="1" y="1" width="358" height="418" rx="12" fill="none" stroke="#888"/>
  <text x="14" y="28" font-size="12" fill="currentColor">tree · 14 entries</text>
  <line x1="1" y1="40" x2="359" y2="40" stroke="#888"/>

  <text x="14" y="62" font-size="8" fill="#7aa2f7">you</text>
  <text x="52" y="62" font-size="9" fill="currentColor">fix the scroll anchor</text>
  <text x="14" y="86" font-size="8" fill="#7aa2f7">pi</text>
  <text x="52" y="86" font-size="9" fill="#cfc9e0">read the window module…</text>

  <text x="28" y="112" font-size="8" fill="#7aa2f7">you</text>
  <text x="66" y="112" font-size="9" fill="currentColor">make it keep scrollHeight − scrollTop</text>
  <text x="28" y="136" font-size="8" fill="#7aa2f7">pi</text>
  <text x="66" y="136" font-size="9" fill="#cfc9e0">patched renderTranscript</text>
  <text x="314" y="112" font-size="8" fill="#bb9af7">current</text>

  <text x="42" y="170" font-size="8" fill="#7aa2f7">you</text>
  <text x="80" y="170" font-size="9" fill="currentColor">try the other offset</text>
  <text x="42" y="188" font-size="7" fill="#6f6889">alternative branch, not the current one</text>
  <rect x="80" y="198" width="82" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="86" y="210" font-size="7" fill="#e7e3f2">fork from here</text>
  <rect x="168" y="198" width="70" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="174" y="210" font-size="7" fill="#e7e3f2">copy prompt</text>

  <text x="56" y="242" font-size="8" fill="#7aa2f7">you</text>
  <text x="94" y="242" font-size="9" fill="currentColor">…</text>
  <text x="14" y="272" font-size="8" fill="#6f6889">tool · bash · compaction · branch summary rows are read-only;</text>
  <text x="14" y="286" font-size="8" fill="#6f6889">only user rows carry actions.</text>
  <line x1="14" y1="304" x2="346" y2="304" stroke="#322b45"/>
  <text x="14" y="324" font-size="9" fill="#e7e3f2">/fork &lt;entryId&gt; · /fork (opens tree) · /clone</text>
  <text x="14" y="342" font-size="8" fill="#6f6889">fork/clone create a new Pi session in the same child,</text>
  <text x="14" y="355" font-size="8" fill="#6f6889">then the hub re-keys and every tab adopts a replace window.</text>
  <text x="14" y="374" font-size="8" fill="#6f6889">in-place leaf navigation is TUI-only: get_tree has no</text>
  <text x="14" y="387" font-size="8" fill="#6f6889">navigate verb, so pixip forks instead of pretending.</text>
  <text x="14" y="406" font-size="8" fill="#6f6889">the original branch and session file stay on disk.</text>
</svg>
```

### Export, import and compaction

```svg
<svg viewBox="0 0 720 360" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf80-flow">
  <title id="wf80-flow">Export sheet, import path, and compaction replacing history with a summary boundary</title>
  <rect x="4" y="4" width="346" height="352" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">EXPORT</text>
  <text x="18" y="48" font-family="ui-monospace, monospace" font-size="11" fill="#e7e3f2">export</text>
  <text x="18" y="66" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">downloads only · nothing is sent to the model</text>
  <rect x="18" y="80" width="140" height="26" rx="5" fill="none" stroke="#7aa2f7"/>
  <text x="26" y="97" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">download HTML</text>
  <rect x="168" y="80" width="140" height="26" rx="5" fill="none" stroke="#7aa2f7"/>
  <text x="176" y="97" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">download JSONL</text>
  <text x="18" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">HTML → &lt;data-dir&gt;/exports/ · JSONL = the session file</text>
  <text x="18" y="142" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">name slug + 8-char id · attachment · no-store</text>
  <line x1="18" y1="158" x2="336" y2="158" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="18" y="180" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">IMPORT</text>
  <text x="18" y="202" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">/import ../other/session.jsonl</text>
  <text x="18" y="220" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">validate header and id · copy into sessions dir</text>
  <text x="18" y="234" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">index cwd/repo/worktree · switch_session · re-key</text>
  <text x="18" y="248" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">not JSONL → error naming the path</text>
  <text x="18" y="262" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">already attached → refused</text>
  <text x="18" y="276" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">cancelled → current session untouched</text>
  <text x="18" y="302" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">/new, fork, clone, import all re-key the live child;</text>
  <text x="18" y="316" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the browser adopts a replacement window, so old</text>
  <text x="18" y="330" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">context cannot be mixed with new.</text>

  <rect x="366" y="4" width="350" height="352" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="380" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">COMPACT REPLACES THE WINDOW</text>
  <rect x="380" y="38" width="322" height="30" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="388" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">old history</text>
  <text x="640" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">12.4k ↑</text>
  <rect x="380" y="74" width="322" height="30" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="388" y="92" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">old history</text>
  <rect x="380" y="110" width="322" height="30" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="388" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">old history</text>
  <line x1="380" y1="154" x2="702" y2="154" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="380" y="172" font-family="ui-monospace, monospace" font-size="8" fill="#7aa2f7">↓ /compact</text>
  <rect x="380" y="184" width="322" height="52" rx="6" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="388" y="202" font-family="ui-monospace, monospace" font-size="9" fill="#bb9af7">compaction · summary</text>
  <text x="388" y="216" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">tokens before/after · duration · collapsed</text>
  <text x="388" y="228" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">full history still readable behind it</text>
  <rect x="380" y="246" width="322" height="30" rx="6" fill="#1d1a29" stroke="#322b45"/>
  <text x="388" y="264" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">new turn</text>
  <text x="380" y="296" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">while running: persistent row + elapsed, composer locked,</text>
  <text x="380" y="310" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">draft kept. success → replace snapshot + footer refresh;</text>
  <text x="380" y="324" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">failure/cancel → toast, no boundary, unchanged history.</text>
  <text x="380" y="344" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">no cancel control yet · open 10-cancel-compaction</text>
</svg>
```

## Port-relevant technical notes

Port notes only; the user-visible rules above are the contract.

### Footer and RPC

`hubLive.footer()` joins `get_session_stats` (tokens, cost, `contextUsage`) with `get_state` (`model`, `thinkingLevel`, `autoCompactionEnabled`) and a cached git branch. It sends raw `FooterData`; `src/client/footer.js` owns all formatting and is tested. `sendFooter` broadcasts after model/thinking/compaction/settled changes.

Model and thinking are real RPC; `_query` frames resolve server-side with the same pure helpers as the tests. Copy, tree, fork, clone, import, export, compact, `new_session`, `set_session_name` and `resnapshot` are session-socket frames. `/session` and footer formats are client-only; `/resume` and `/quit` are navigation. `src/commands.ts` imports `resolvePolicy` from the client module.

### Naming

`src/titles.ts` is pure (`normalizeTitle`, `isSlashPrompt`, `messageText`, `fallbackTitle`, `titlePrompt`). `autoLabel` resolves the title model, runs a separate `pi --print` (or host `--print`) child with a 15 s timeout and stdin EOF, retries once on a busy `agent_settled`, then falls back locally. `titleAttempted` makes it one-shot per Pi id and a re-key resets it. `prompt` starts it only at `messageCount === 0`; a slash prompt sets `titleAwaitingMessage` so the expanded user `message_start` is used. `hubLive` treats `session_info_changed` as manual and persists `nameSource`.

### Identity and re-key

`newSession`, `fork`, `clone` and `importSession` end in `rekeyFromState`: `get_state` mutates `live.info` in place, moves the `this.live` entry, re-upserts the index under the stable `logicalId`, and notifies listeners. The socket sends `opened` with `rekey`; the client sends `resnapshot` for `replace: true`. `importSession` validates and copies the JSONL into `<data-dir>/sessions/`, refuses traversal and attached ids, detects repo/worktree, and runs `switch_session`. Fork and clone keep the process, extension closures and pending UI.

### Export and compaction

`exportHtml` asks Pi for `export_html` into `<data-dir>/exports/<slug>-<8-char-id>.html` and caches it; `exportedHtml` regenerates on a miss. `GET /api/sessions/:id/export.html` serves that file, `export.jsonl` serves `sessionFile(id)`, both as `attachment` with `no-store`.

`compact` sends RPC `compact` with `customInstructions` and no timeout, then the footer. Compaction events are forwarded verbatim; `src/client/compaction.js` holds the progress timer and the estimate carried until the replacement snapshot. `compaction_end`, including automatic threshold/overflow, calls `scheduleFooter`. A successful flow sends `resnapshot`; `replace: true` drops pre-compaction windows, and `state.compactionMeta` attaches to the `compaction` entry. `abort` exists on the wire but no compaction control sends it.

### Client state

`state.footer`, `state.models`, `state.levels`, `state.compactionResult`, `state.compactionMeta` and `state.sessionCache` matter here. `snapshotSession` caches footer, info, entries, policy, commands, addon, queue and draft for a parked session, so returning repaints the footer without a request. `flattenTree` builds the tree sheet; the tree and export sheets paint with `textContent`.

## Boundaries

The dashboard owns discovery, grouping, stop/wake entry points, archive and trash (`10-dashboard-sessions`). The transcript area owns message copy affordances, ref tags and the compaction boundary's detail (`20-transcript-reading`). The composer owns prompt/steer dispatch and the command menu (`30-composer-input`); this area owns what commands do. Footer status text and widgets belong to extensions (`50-bundled-extensions`). Live-session archive identity is `06-archive-session-identity`; cancel-compaction is `10-cancel-compaction`; daemon supervision is `85-daemon-cli`.

## Sources

`src/client/footer.js`, `sessionInfo.js`, `tree.js`, `sheets.js`, `composer.js`, `commands.js`, `compaction.js`, `sessionEffects.js`, `sessionPlan.js`, `sessionView.js`, `clipboard.js`, `frames.js`, `src/titles.ts`, `src/commands.ts`, `src/hubSession.ts`, `src/hubLive.ts`, `src/hubControl.ts`, `src/wire.ts`, `src/server.ts` (export route), `test/footer.test.js`, `test/titles.test.ts`, `test/tree.test.js`, `test/commands.test.js`, `README.md` (what works), `docs/TUI-parity.md`, `ARCHITECTURE.md` (status line and session controls, built-in slash commands, sessions and naming), `fit/open/10-cancel-compaction.md`, and `fit/open/06-archive-session-identity.md`.

# 10 · Dashboard and sessions

The dashboard is the product's home surface: every session on this box, grouped
by repository and worktree, with live state dots and one-tap access to whatever
needs attention. From here a user starts a session in a typed path, a browsed
directory or a fresh worktree, then opens, stops, protects, archives or deletes
it. The header carries only what applies at this level (settings and display
options). The dashboard is phone-first and stays one centred column when the
window widens.

## Contents

- [What people want from this screen](#what-people-want-from-this-screen)
- [How the dashboard fits in](#how-the-dashboard-fits-in)
- [Finding a session](#finding-a-session): grouping, collapse rules, rows, empty state
- [Starting a session](#starting-a-session): typed path, picker, group `+`, worktree, starting shell
- [Acting on a session](#acting-on-a-session): open, wake, stop, protect, archive, delete, bulk, rename
- [Header and display options](#header-and-display-options)
- [Settings, archived and trash](#settings-archived-and-trash)
- [Wireframes](#wireframes): phone, wide, sheets, stored sessions, decision flow
- [Technical notes (port-relevant)](#technical-notes-port-relevant)

## What people want from this screen

- On a phone, find the right session fast, because groups follow repositories.
- With many sessions, still see active and newest work when groups are collapsed.
- Start work at a typed path, a browsed directory or a fresh worktree.
- Archive one session or all inactive ones, undo a delete, restore from archive or
  trash.
- Come back later and still see stopped sessions by name.

## How the dashboard fits in

`/` opens the dashboard: a sticky header, the list, and a fixed inbox bar. It
contains no transcript; opening a row replaces the list with that session's page,
and `‹` brings the list back. The header reads `sessions` with no status dot and no
stop button, because the dashboard is not a session.

The list is content-driven: a `sessions` frame from the hub repaints it, so rows
turn busy or waiting without the user touching anything, and a half-typed path
survives those repaints. If an open session vanishes elsewhere, a `session is no
longer available` toast returns the user to the list. The inbox bar is only a
preview here; see **60 · Inbox and reports**.

## Finding a session

### Grouping by repository and worktree

Sessions are grouped by directory, hierarchically. A repository with sessions in
its own root and in linked worktrees gets one parent group: direct sessions are
rows under it, and each linked worktree is an indented child group with its own
shortened branch name. A non-repository cwd stays flat, and a worktree group
appears even with no direct session in the repository.

Groups sort by newest activity and rows inside a group are newest first, so the
thing touched last is nearest the top. The header carries a chevron, the
home-shortened path (`~/dev/sin/pixip`), a git branch chip when one could be
resolved, and a count such as `5 sessions · 3 hidden`; the chip distinguishes two
worktrees of one repository.

A group's `+` reuses that location: a plain directory starts a session
immediately, while a repository or worktree opens `new session` plus
`new with worktree` (repository) or `delete worktree` (worktree). The worktree
lifecycle itself is **70 · Worktrees**.

### Collapsed groups and the visibility rule

Groups arrive collapsed, even ones the user has never seen, so a long-running box
does not open on stopped sessions. A collapsed group
still shows every *hot* session (`busy` or `starting`), every *warm* session
(`idle`), and the group's newest session even when it is stopped; the rest is
folded away behind the count. A collapsed repository group also hides its
worktree children, though they still count towards the total.

The chevron only appears when collapsing would hide a row, so a small group reads
as a plain title instead of a dead control. Opening a group shows all its rows,
and the choice is remembered per browser. The exemption is a device-local setting,
on by default: turned off, a collapsed group hides every row. The settings sheet
states the rule in plain words — *hot = busy or starting, warm = idle* — and warns
that off hides everything.

### The session row

One row is one session. The left half opens it; the separate `⋯` half never
navigates. The first line is a 9 px state dot, the name, and a right-aligned
`state · 3m` label.
Names truncate rather than wrap, and an unnamed session falls back to the first
eight characters of its id. The 38 px actions strip is separated by a hairline.

The dot is the same indicator the session header uses, and it carries most of the
dashboard's meaning:

| Dot | Meaning |
| --- | --- |
| red `error` | The child failed; outranks all else. |
| pink-red `waiting` | A blocking question or recorded re-ask needs the user. |
| green `idle` | A live child is attached and ready. |
| pulsing accent `busy` | The agent is working. |
| grey `stopped` | No child; the file survives and can be woken. |
| pulsing `starting` | The child is booting. |

`error` beats `waiting`, which beats `idle`, `busy`, `stopped` and `starting`, so a
problem is never painted over by a calmer state. A protected session also shows a
small purple dot before its name.

### When there is nothing to show

A fresh data directory keeps the new-session form and paints one quiet row, `no
sessions yet`, in the same row shell as a real session.

## Starting a session

### The new-session form

The first item is a form with a path field, `browse`, `new` and `new with
worktree`. The field is prefilled with the daemon's working directory when known,
with `/path/to/project` as placeholder; it avoids iOS zooming and turns off
autocapitalisation, autocorrection and spellcheck, because paths are typed or
pasted constantly.

`new` sends a create for the typed path and immediately pushes the synthetic
`#new` route, so the user lands on the session page instead of waiting on the
list. If the create fails, that page shows a local error block and a `back to
sessions` action instead of a dead id. Reloading `#new` without a create in flight
falls back to the dashboard. `new with worktree` opens the worktree sheet.

### Browsing for a directory

`browse` opens a modal sheet, not a native file dialog. It starts at the daemon's
cwd when that lies inside home, otherwise at the home root, and never leaves home:
the server resolves every path and refuses a symlink that escapes the root. The
sheet has a breadcrumb trail from `~`, a filter, an `..` row, and subdirectories
with a `git` badge for anything containing `.git`. `use this directory` writes the
path back into the new-session field and closes without creating anything;
`new folder` creates one directory in the current folder.

### Starting from a group

A group's `+` reuses that group's cwd. For a plain directory it starts the session
directly; for a repository or worktree it opens the group menu above, with
`new session` beside the worktree verbs.

### New with worktree

The worktree sheet proposes a slug from the repository name and shows, before
anything is created, the directory and the full `pixip/<slug>` branch. The slug is
editable and normalised, and a collision gets a numeric suffix with a visible
explanation. Creating starts a session inside the new worktree, with the branch
cut from the repository's current `HEAD`; full behaviour belongs to
**70 · Worktrees**.

### While the session is starting

Until the child reports in, the new session's page is shown, not a spinner on the
list: a `starting…` subtitle, a `starting session…` block, a pulsing busy dot and a
disabled composer and attach button.

## Acting on a session

### Open, wake and stop

Tapping the open half of a row opens the session. A stopped session still appears
with its name, and opening it reattaches to the same file. The explicit `wake
session` button lives in the transcript, so the list's only verb is `open`. `stop`
appears in the row actions for a live session and stops the child while keeping
the file; it is also in a session's header.

### Protect, archive, delete and undo

The row's `⋯` opens `session · <name>` with the actions that fit the current
state: `stop` when live, `protect` or `unprotect`, `archive`, and `delete`.

*Protect* is the bulk-archive exemption: stored with the session, surviving
archive and restore, also settable with `pixip protect`. A protected row shows a
purple dot and is never a bulk target; the explicit `archive` still works on it.

*Archive* is the reversible way off the dashboard. It confirms, notes that the
session can be restored from `settings › archived`, and moves the files into the
archive store.

*Delete* is destructive but not immediate: the confirmation says the JSONL files
go to trash and stay undoable for a moment. A toast carries `undo` for ten
seconds, restoring the session and repainting the list. Both actions drop the
browser's cached transcript so a reopened id cannot show stale content.

### Bulk archive of inactive sessions

When at least one stopped, unprotected session can be archived, a quiet `archive
inactive (3)` button appears under the form. The count is the number of rows the
action would hide: a group with no active session keeps its newest stopped row, so
cleanup never makes a repository group disappear, while a group with a live
session can lose every stopped row.

The button is self-starting and confirms first, restating the keep-one rule. The
result reads `archived 4` or `archived 3 · 1 failed`, and the list repaints from
the hub's list. There is no checkbox multi-select; "bulk" means exactly the
inactive set the hub and the client agree on.

### Renaming

There is no rename action in the list; renaming happens inside a session with
`/name`, and the name flows back through the session list. Auto-titling and manual
override are in **80 · Session control**.

## Header and display options

One sticky header serves both routes, and its controls swap. On the dashboard it
shows `sessions`, the settings gear and the `…` overflow; the back button, status
dot and `stop` are absent. In a session the back button and title/subtitle appear,
the gear disappears, and `stop` is added; the overflow menu exists on both. The
session subtitle is `state · model · thinking · N msg`, with model/thinking hidden
on narrow phones so it never wraps.

`…` opens a popover with transcript text size and a soft reload. Text size is
`A−`, the current percentage and `A+`, in seven steps from 50 % to 150 %; it
scales only the transcript, so composer and chrome stay put. The value is
device-local and survives reloads, a long press resets it to 100 %, and
`Ctrl/Cmd` `-`/`+`/`0` do the same; buttons disable at the ends of the range.
`reload` performs a soft refresh — the hub re-reads assets, command policy and the
session index without touching live children — then reloads the page, reporting a
failure in a toast. The popover closes on Escape or an outside click.

## Settings, archived and trash

The gear opens `settings`: the collapsed-group visibility toggle with its
one-line explanation, then `archived (N)` and `trash (N)`.

The archived view lists sessions by name with home-shortened cwd and relative
time. Each row has `restore` and `delete`, the latter permanently removing its
files after a browser confirmation. The trash view has the same shape with
`restore` and `purge`; its hint says deleted sessions stay briefly and can also be
recovered from the delete toast. Both repaint after a restore or purge.

## Wireframes

### Phone dashboard

```svg
<svg viewBox="0 0 360 720" width="100%" style="max-width:400px" role="img" aria-labelledby="wf-phone-title">
  <title id="wf-phone-title">Phone dashboard: header, new-session form, bulk archive, collapsed groups with pinned rows, and the inbox bar</title>
  <rect x="1" y="1" width="358" height="718" rx="14" fill="none" stroke="#888"/>
  <text x="16" y="30" font-size="13" fill="currentColor">sessions</text>
  <text x="300" y="30" font-size="13" fill="currentColor">⚙</text>
  <text x="328" y="30" font-size="13" fill="currentColor">…</text>
  <line x1="1" y1="42" x2="359" y2="42" stroke="#888"/>
  <rect x="14" y="54" width="224" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="74" font-size="11" fill="#777">/home/you/dev/project</text>
  <rect x="242" y="54" width="48" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="252" y="74" font-size="11" fill="currentColor">browse</text>
  <rect x="294" y="54" width="52" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="308" y="74" font-size="11" fill="currentColor">new</text>
  <text x="14" y="104" font-size="10" fill="#777">new with worktree</text>
  <text x="14" y="127" font-size="10" fill="#777">archive inactive (3)</text>
  <rect x="14" y="140" width="332" height="26" rx="5" fill="none" stroke="#888"/>
  <text x="22" y="157" font-size="11" fill="currentColor">▸ ~/dev/sin/pixip</text>
  <text x="176" y="157" font-size="10" fill="#777">master</text>
  <text x="238" y="157" font-size="10" fill="#777">5 sessions · 3 hidden</text>
  <text x="330" y="157" font-size="12" fill="currentColor">+</text>
  <rect x="22" y="172" width="316" height="32" rx="6" fill="none" stroke="#888"/>
  <circle cx="36" cy="188" r="4" fill="currentColor"/>
  <text x="46" y="192" font-size="11" fill="currentColor">Grill and close tickets</text>
  <text x="238" y="192" font-size="10" fill="#777">busy · 3m</text>
  <line x1="316" y1="172" x2="316" y2="204" stroke="#888"/>
  <text x="329" y="192" font-size="12" fill="currentColor">⋯</text>
  <rect x="22" y="210" width="316" height="32" rx="6" fill="none" stroke="#888"/>
  <circle cx="36" cy="226" r="4" fill="none" stroke="currentColor"/>
  <text x="46" y="230" font-size="11" fill="currentColor">Dashboard inventory</text>
  <text x="238" y="230" font-size="10" fill="#777">idle · 12m</text>
  <line x1="316" y1="210" x2="316" y2="242" stroke="#888"/>
  <text x="329" y="230" font-size="12" fill="currentColor">⋯</text>
  <rect x="14" y="258" width="332" height="26" rx="5" fill="none" stroke="#888"/>
  <text x="22" y="275" font-size="11" fill="currentColor">▸ ~/dev/other/repo</text>
  <text x="220" y="275" font-size="10" fill="#777">4 sessions · 4 hidden</text>
  <text x="330" y="275" font-size="12" fill="currentColor">+</text>
  <text x="14" y="308" font-size="10" fill="#777">a collapsed repository hides its worktree groups;</text>
  <text x="14" y="322" font-size="10" fill="#777">hot, warm and the newest session stay visible</text>
  <line x1="1" y1="664" x2="359" y2="664" stroke="#888"/>
  <text x="16" y="685" font-size="11" fill="currentColor">✉ feature inventory: dashboard done</text>
  <text x="300" y="685" font-size="10" fill="#777">unread 1</text>
  <text x="16" y="704" font-size="9" fill="#777">opens the inbox page</text>
</svg>
```

### Wide dashboard

```svg
<svg viewBox="0 0 900 520" width="100%" style="max-width:900px" role="img" aria-labelledby="wf-wide-title">
  <title id="wf-wide-title">Wide dashboard: the same single centred column, with extra header detail and untruncated names</title>
  <rect x="1" y="1" width="898" height="518" rx="14" fill="none" stroke="#888"/>
  <text x="16" y="30" font-size="13" fill="currentColor">sessions</text>
  <text x="840" y="30" font-size="13" fill="currentColor">⚙</text>
  <text x="868" y="30" font-size="13" fill="currentColor">…</text>
  <line x1="1" y1="42" x2="899" y2="42" stroke="#888"/>
  <text x="70" y="74" font-size="10" fill="#777">header padding centres on 104ch</text>
  <rect x="280" y="86" width="340" height="504" rx="8" fill="none" stroke="#888" stroke-dasharray="4 3"/>
  <text x="292" y="104" font-size="10" fill="#777">list column, max 760 px</text>
  <rect x="296" y="112" width="220" height="28" rx="5" fill="none" stroke="#888"/>
  <text x="304" y="130" font-size="10" fill="#777">/home/you/dev/project</text>
  <rect x="522" y="112" width="40" height="28" rx="5" fill="none" stroke="#888"/>
  <text x="530" y="130" font-size="10" fill="currentColor">browse</text>
  <rect x="568" y="112" width="40" height="28" rx="5" fill="none" stroke="currentColor"/>
  <text x="580" y="130" font-size="10" fill="currentColor">new</text>
  <rect x="296" y="152" width="312" height="24" rx="5" fill="none" stroke="#888"/>
  <text x="304" y="168" font-size="10" fill="currentColor">▾ ~/dev/sin/pixip</text>
  <text x="430" y="168" font-size="9" fill="#777">master</text>
  <text x="490" y="168" font-size="9" fill="#777">5 sessions</text>
  <text x="596" y="168" font-size="11" fill="currentColor">+</text>
  <rect x="304" y="182" width="296" height="28" rx="5" fill="none" stroke="#888"/>
  <circle cx="316" cy="196" r="4" fill="currentColor"/>
  <text x="326" y="200" font-size="10" fill="currentColor">Grill and close the dashboard inventory tickets</text>
  <text x="522" y="200" font-size="9" fill="#777">busy · 3m</text>
  <text x="592" y="200" font-size="11" fill="currentColor">⋯</text>
  <rect x="304" y="216" width="296" height="28" rx="5" fill="none" stroke="#888"/>
  <circle cx="316" cy="230" r="4" fill="none" stroke="currentColor"/>
  <text x="326" y="234" font-size="10" fill="currentColor">Dashboard inventory notes</text>
  <text x="522" y="234" font-size="9" fill="#777">idle · 12m</text>
  <text x="592" y="234" font-size="11" fill="currentColor">⋯</text>
  <text x="296" y="272" font-size="10" fill="#777">widening reveals full session names and the header's</text>
  <text x="296" y="286" font-size="10" fill="#777">model/thinking segment; the column itself does not</text>
  <text x="296" y="300" font-size="10" fill="#777">become a rail or a card grid</text>
  <text x="640" y="250" font-size="10" fill="#777">no second column:</text>
  <text x="640" y="264" font-size="10" fill="#777">a desktop surface is a</text>
  <text x="640" y="278" font-size="10" fill="#777">separate, undecided design</text>
</svg>
```

### New-session and directory sheets

```svg
<svg viewBox="0 0 720 520" width="100%" style="max-width:720px" role="img" aria-labelledby="wf-sheet-title">
  <title id="wf-sheet-title">Two sheets: the new-session fields and the home-fenced directory picker</title>
  <rect x="1" y="1" width="348" height="518" rx="14" fill="none" stroke="#888"/>
  <text x="16" y="28" font-size="12" fill="currentColor">new session</text>
  <rect x="14" y="42" width="240" height="36" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="65" font-size="11" fill="#777">/path/to/project</text>
  <rect x="262" y="42" width="88" height="36" rx="6" fill="none" stroke="#888"/>
  <text x="274" y="65" font-size="11" fill="currentColor">browse</text>
  <rect x="14" y="86" width="110" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="30" y="106" font-size="11" fill="currentColor">new</text>
  <rect x="132" y="86" width="150" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="144" y="106" font-size="11" fill="currentColor">new with worktree</text>
  <text x="14" y="134" font-size="10" fill="#777">typed path starts from the daemon cwd;</text>
  <text x="14" y="148" font-size="10" fill="#777">browse fills the field, it does not create</text>
  <text x="14" y="172" font-size="11" fill="currentColor">new with worktree</text>
  <rect x="14" y="184" width="190" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="204" font-size="11" fill="currentColor">pixip</text>
  <text x="14" y="238" font-size="10" fill="#777">directory: …/pixip_worktrees/pixip/pixip</text>
  <text x="14" y="252" font-size="10" fill="#777">branch: pixip/pixip</text>
  <text x="14" y="274" font-size="10" fill="#777">slug is editable; a collision gets a suffix</text>
  <rect x="14" y="292" width="150" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="26" y="312" font-size="11" fill="currentColor">create worktree</text>
  <rect x="240" y="292" width="70" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="252" y="312" font-size="11" fill="currentColor">cancel</text>
  <rect x="371" y="1" width="348" height="518" rx="14" fill="none" stroke="#888"/>
  <text x="386" y="28" font-size="12" fill="currentColor">choose directory</text>
  <text x="386" y="52" font-size="11" fill="currentColor">~ / dev / sin / pixip</text>
  <rect x="386" y="64" width="318" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="394" y="83" font-size="10" fill="#777">filter directories…</text>
  <text x="386" y="114" font-size="11" fill="currentColor">..</text>
  <text x="386" y="136" font-size="11" fill="currentColor">src</text>
  <text x="386" y="158" font-size="11" fill="currentColor">docs</text>
  <text x="386" y="180" font-size="11" fill="currentColor">feature_inventory_worktrees</text>
  <rect x="626" y="122" width="26" height="16" rx="3" fill="none" stroke="#888"/>
  <text x="631" y="134" font-size="9" fill="#777">git</text>
  <text x="386" y="208" font-size="10" fill="#777">fenced to the home root; server resolves</text>
  <text x="386" y="222" font-size="10" fill="#777">every path, symlinks never escape</text>
  <rect x="386" y="238" width="150" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="396" y="258" font-size="11" fill="currentColor">use this directory</text>
  <rect x="544" y="238" width="78" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="554" y="258" font-size="11" fill="currentColor">new folder</text>
  <rect x="630" y="238" width="74" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="650" y="258" font-size="11" fill="currentColor">close</text>
  <text x="386" y="296" font-size="10" fill="#777">"use this directory" writes the path back into</text>
  <text x="386" y="310" font-size="10" fill="#777">the new-session field and closes the sheet</text>
</svg>
```

### Archived and trash

```svg
<svg viewBox="0 0 720 420" width="100%" style="max-width:720px" role="img" aria-labelledby="wf-stored-title">
  <title id="wf-stored-title">Settings sheet with archived and trash views, each row carrying restore and delete or purge</title>
  <rect x="1" y="1" width="348" height="418" rx="14" fill="none" stroke="#888"/>
  <text x="16" y="28" font-size="12" fill="currentColor">settings</text>
  <text x="326" y="28" font-size="12" fill="currentColor">×</text>
  <rect x="18" y="44" width="14" height="14" rx="3" fill="none" stroke="currentColor"/>
  <text x="40" y="55" font-size="10" fill="currentColor">keep hot/warm and newest visible</text>
  <text x="18" y="80" font-size="9" fill="#777">hot = busy or starting · warm = idle</text>
  <rect x="18" y="96" width="120" height="30" rx="6" fill="none" stroke="currentColor"/>
  <text x="28" y="116" font-size="11" fill="currentColor">archived (3)</text>
  <rect x="146" y="96" width="100" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="156" y="116" font-size="11" fill="currentColor">trash (1)</text>
  <rect x="254" y="96" width="76" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="280" y="116" font-size="11" fill="currentColor">close</text>
  <text x="18" y="152" font-size="10" fill="#777">the checkbox is device-local; archive and</text>
  <text x="18" y="166" font-size="10" fill="#777">trash lists come from the hub</text>
  <rect x="371" y="1" width="348" height="418" rx="14" fill="none" stroke="#888"/>
  <text x="386" y="28" font-size="12" fill="currentColor">archived (3)</text>
  <text x="386" y="48" font-size="9" fill="#777">restore to the dashboard, or delete permanently</text>
  <rect x="386" y="62" width="318" height="44" rx="6" fill="none" stroke="#888"/>
  <text x="394" y="80" font-size="11" fill="currentColor">Grill and close tickets</text>
  <text x="394" y="96" font-size="9" fill="#777">~/dev/sin/pixip · 2d</text>
  <rect x="574" y="70" width="56" height="26" rx="5" fill="none" stroke="currentColor"/>
  <text x="583" y="88" font-size="10" fill="currentColor">restore</text>
  <rect x="636" y="70" width="60" height="26" rx="5" fill="none" stroke="#888"/>
  <text x="648" y="88" font-size="10" fill="currentColor">delete</text>
  <rect x="386" y="114" width="318" height="44" rx="6" fill="none" stroke="#888"/>
  <text x="394" y="132" font-size="11" fill="currentColor">Dashboard inventory</text>
  <text x="394" y="148" font-size="9" fill="#777">~/dev/other/repo · 5d</text>
  <rect x="574" y="122" width="56" height="26" rx="5" fill="none" stroke="currentColor"/>
  <text x="583" y="140" font-size="10" fill="currentColor">restore</text>
  <rect x="636" y="122" width="60" height="26" rx="5" fill="none" stroke="#888"/>
  <text x="648" y="140" font-size="10" fill="currentColor">delete</text>
  <text x="386" y="184" font-size="9" fill="#777">trash rows read restore / purge; deleted sessions</text>
  <text x="386" y="198" font-size="9" fill="#777">also carry a 10 s undo on the delete toast</text>
  <rect x="386" y="216" width="74" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="396" y="236" font-size="11" fill="currentColor">settings</text>
  <rect x="468" y="216" width="70" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="488" y="236" font-size="11" fill="currentColor">close</text>
</svg>
```

### Decision flow

```svg
<svg viewBox="0 0 900 470" width="100%" style="max-width:900px" role="img" aria-labelledby="wf-flow-title">
  <title id="wf-flow-title">Decision flow: find a session then open, wake or stop it; create one from four entry points; archive versus delete versus undo</title>
  <rect x="16" y="24" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
  <text x="34" y="49" font-size="12" fill="currentColor">dashboard</text>
  <rect x="210" y="24" width="170" height="40" rx="8" fill="none" stroke="#888"/>
  <text x="222" y="49" font-size="11" fill="currentColor">find a session</text>
  <rect x="430" y="16" width="130" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="442" y="35" font-size="10" fill="currentColor">group by repo</text>
  <rect x="430" y="52" width="130" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="442" y="71" font-size="10" fill="currentColor">expand a group</text>
  <rect x="600" y="16" width="150" height="28" rx="6" fill="none" stroke="currentColor"/>
  <text x="612" y="35" font-size="10" fill="currentColor">open the session</text>
  <rect x="600" y="52" width="150" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="612" y="71" font-size="10" fill="currentColor">wake if stopped</text>
  <rect x="600" y="88" width="150" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="612" y="107" font-size="10" fill="currentColor">stop if live</text>
  <line x1="166" y1="44" x2="210" y2="44" stroke="#888"/>
  <line x1="380" y1="44" x2="430" y2="30" stroke="#888"/>
  <line x1="380" y1="44" x2="430" y2="66" stroke="#888"/>
  <line x1="560" y1="30" x2="600" y2="30" stroke="#888"/>
  <line x1="560" y1="66" x2="600" y2="66" stroke="#888"/>
  <line x1="560" y1="66" x2="600" y2="102" stroke="#888"/>
  <rect x="16" y="150" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
  <text x="34" y="175" font-size="12" fill="currentColor">create</text>
  <rect x="210" y="130" width="170" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="149" font-size="10" fill="currentColor">typed path · new</text>
  <rect x="210" y="166" width="170" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="185" font-size="10" fill="currentColor">browse → use directory</text>
  <rect x="210" y="202" width="170" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="221" font-size="10" fill="currentColor">group + </text>
  <rect x="210" y="238" width="170" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="257" font-size="10" fill="currentColor">new with worktree</text>
  <rect x="430" y="150" width="170" height="56" rx="8" fill="none" stroke="currentColor"/>
  <text x="442" y="172" font-size="11" fill="currentColor">#new shell: starting…</text>
  <text x="442" y="190" font-size="9" fill="#777">disabled composer, error + back</text>
  <line x1="166" y1="170" x2="210" y2="144" stroke="#888"/>
  <line x1="166" y1="170" x2="210" y2="180" stroke="#888"/>
  <line x1="166" y1="170" x2="210" y2="216" stroke="#888"/>
  <line x1="166" y1="170" x2="210" y2="252" stroke="#888"/>
  <line x1="380" y1="144" x2="430" y2="170" stroke="#888"/>
  <line x1="380" y1="180" x2="430" y2="176" stroke="#888"/>
  <line x1="380" y1="216" x2="430" y2="182" stroke="#888"/>
  <line x1="380" y1="252" x2="430" y2="188" stroke="#888"/>
  <rect x="16" y="320" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
  <text x="34" y="345" font-size="12" fill="currentColor">row ⋯</text>
  <rect x="210" y="300" width="150" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="319" font-size="10" fill="currentColor">protect / unprotect</text>
  <rect x="210" y="336" width="150" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="355" font-size="10" fill="currentColor">archive (confirm)</text>
  <rect x="210" y="372" width="150" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="222" y="391" font-size="10" fill="currentColor">delete (confirm)</text>
  <rect x="400" y="336" width="150" height="28" rx="6" fill="none" stroke="currentColor"/>
  <text x="412" y="355" font-size="10" fill="currentColor">settings › archived</text>
  <rect x="400" y="372" width="150" height="28" rx="6" fill="none" stroke="currentColor"/>
  <text x="412" y="391" font-size="10" fill="currentColor">toast: undo (10 s)</text>
  <rect x="590" y="354" width="170" height="28" rx="6" fill="none" stroke="#888"/>
  <text x="602" y="373" font-size="10" fill="currentColor">restore or delete / purge</text>
  <line x1="166" y1="340" x2="210" y2="314" stroke="#888"/>
  <line x1="166" y1="340" x2="210" y2="350" stroke="#888"/>
  <line x1="166" y1="340" x2="210" y2="386" stroke="#888"/>
  <line x1="360" y1="350" x2="400" y2="350" stroke="#888"/>
  <line x1="360" y1="386" x2="400" y2="386" stroke="#888"/>
  <line x1="550" y1="364" x2="590" y2="368" stroke="#888"/>
</svg>
```

## Technical notes (port-relevant)

### Where the list and its state come from

The dashboard's model is `SessionInfo`, sent as the `GET /api/sessions` response
and as `sessions` frames on the session-less dashboard socket. It is assembled
from live children (so a just-created session with no JSONL still appears), a
bounded JSONL scan, then the session index. JSONL wins for state, name and
activity; the index adds the logical id tying a reattached Pi id to the same pixip
session and a name when the scan misses a late `session_info`.

`state` is `stopped` for anything read off disk; a live child overrides it with
`starting`, `idle`, `busy` or `error`. `awaitingUser` is set when the live child
holds a pending blocking request *or* a timed-out re-ask record exists for the
session's logical id, so a stopped session can still show `waiting`.
`lastActivity` is the header timestamp on disk and the live clock while attached.
`branch` is resolved once per cwd (`git rev-parse --abbrev-ref HEAD`, cached about
5 s; detached HEAD uses the short SHA) and `repo` once per cwd. None of this joins
the streaming path, and the precedence rule lives in one pure client function
shared by row and header.

### Grouping and ordering

Grouping is client-side and pure (`sessionGroups.js`); the hub never groups. Keys
are `repo:<path>`, `worktree:<path>` or a normalised cwd. Parents own direct rows
plus child worktree groups, and counts include descendants. Rows and groups sort
by newest activity with an id/path tiebreak, so a refresh cannot reshuffle equal
timestamps. Pinning is `hot ∪ warm ∪ newest-direct-session`, computed from the
parent's direct sessions; a collapsed parent hides children regardless of pin.

### Idle detach, park and reattach

The hub keeps process state, not conversation state. `agent_settled` (or a fresh
idle attach) starts an idle-detach timer; on expiry the child is closed and its
JSONL kept. The row then reads `stopped`, and opening it re-spawns with `--session
<file>`, so it keeps its name and place. Switching away parks a warm session
socket instead of closing it, and the list evicts a parked socket once its session
stops or disappears.

### What rides REST and what rides the socket

List and mutations are HTTP: `GET`/`POST /api/sessions`,
`POST /api/sessions/:id/{stop,protect,archive}`, `DELETE /api/sessions/:id`
(returning the undo token and expiry), `POST /api/sessions/archive-inactive`,
`GET /api/archived`, `GET /api/trash`, and the archive/trash restore and purge
pairs. Directory discovery is `GET`/`POST /api/dirs`; worktree listing and removal
are `GET`/`DELETE /api/worktrees`; `GET /api/info` supplies default cwd and home
root. `create` and `stop` also exist as socket messages because a create pushes
`#new`. After any mutation the client repaints from the hub's list, and the hub
broadcasts `sessions` to attached pages.

Directory discovery is server-fenced: the server resolves paths with `realpath`,
refuses anything outside `$HOME`, and lists names and a `.git` check only. The UI
has no authentication, which is why the fence and the loopback bind live on the
server.

### Device-local settings

Two values live in `localStorage` and never reach the hub: the collapse map
(`pixip.sessionGroups.collapsed`, key → boolean) and the pinning toggle
(`pixip.sessionGroups.keepActive`, absent/`1` on, `0` off), both with pure parsers
so malformed storage degrades to defaults. The protected flag is the opposite: it
belongs to the session, is written to the index, and survives archive/restore and
restarts so dashboard and CLI agree.

### Layout boundary

The dashboard is one column at every width: the list is centred with a 760 px cap,
the header pads to a 104ch reading width, and only the session header's
model/thinking segment drops below 560 px. Widening reveals fuller names but adds
no column, rail or card grid; the inbox bar stays pinned and the list is the only
scroller.

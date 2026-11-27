# Worktrees and repository groups

A worktree is pixip's way to run a second agent on the same repository without disturbing the first: a real git working directory on its own `pixip/<slug>` branch, created from the dashboard in one confirm step. Sessions are grouped by repository and tree so parallel work stays distinguishable, and peers in one directory are named in the transcript. Removing a tree is always explicit, never a side effect of stopping, archiving or deleting a session.

## Contents

- [User stories](#user-stories)
- [What a worktree is](#what-a-worktree-is)
- [The repository tree on the dashboard](#the-repository-tree-on-the-dashboard)
- [Starting work in a new worktree](#starting-work-in-a-new-worktree)
- [Joining or switching to an existing worktree](#joining-or-switching-to-an-existing-worktree)
- [Sharing a directory with peers](#sharing-a-directory-with-peers)
- [Removing a worktree](#removing-a-worktree)
- [Pruning stale trees](#pruning-stale-trees)
- [The command line](#the-command-line)
- [Archive, delete and restart](#archive-delete-and-restart)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want to start work in a fresh worktree without typing git commands, so a second agent does not fight the first over the same files.
- As a user with several worktrees, I want sessions grouped by the tree they belong to, so I can tell `pixip/fix-a` from `pixip/fix-b`.
- As a user, I want to join or switch to an existing worktree from the dashboard rather than opening a terminal.
- As a user, I want to remove a worktree with a clear confirmation, and a force step when uncommitted work would be lost.
- As a user, I want a stale tree whose directory disappeared to be prunable without touching a live tree.
- As an operator, I want the same listing and removal from the CLI, on a headless box or over SSH.

## What a worktree is

A worktree is a parallel working directory, not a sandbox: agents in different trees share the same user, network, credentials and filesystem. The tree separates files and a checked-out branch; isolation is a container or a separate machine.

pixip-created trees live beside the repository: `<repo-parent>/pixip_worktrees/<repo-name>/<slug>`. The slug is the directory name and branch suffix, so `fix-reconnect` becomes `pixip/fix-reconnect`. Trees branch from the main repository's current `HEAD` unless a caller supplies a base; an invalid or taken branch is refused rather than renamed.

Identity has two layers. A *repository* is the main tree's root, carried by every session in its worktrees and subdirectories. A *worktree* is a linked tree with its own root, branch, and a flag for whether pixip created it or mounted a session in it. The branch chip is separate: the checked-out branch of the session's exact cwd, with detached head as its short SHA and no chip outside a repository.

Joining is detection, not creation. Opening a session at an existing linked worktree never runs `worktree add`; the hub reads the layout and inherits `{repo, path, branch}`, so a hand-made tree lands in the right group.

## The repository tree on the dashboard

The list is hierarchical: one parent group per repository, direct rows for main-tree sessions, and one child group per linked worktree. Non-repository directories stay flat, so a scratch folder grows no synthetic chrome. A parent is synthesized from a worktree row's repository even when no main-tree session exists.

A header shows the home-shortened path, a branch chip where known, and a count. The parent counts every descendant (`4 sessions · 2 hidden`); a worktree header labels its branch without `pixip/` and counts only its own sessions. Parent order is by newest activity anywhere in the group, children by their newest session; ties break on path so refresh never reshuffles equal timestamps.

Every group is collapsible. A new group starts collapsed, and the choice is device-local. A collapsed parent still shows every hot (`busy`, `starting`) or warm (`idle`) direct session plus its newest direct session, and hides worktree children. The header gear holds a pinning toggle; with pinning off, a collapsed group shows nothing. Expanding reveals direct rows then worktree children, each with its own collapse state.

A worktree child's `+` offers `new session` (same directory, no git mutation) and `delete worktree`; a repository parent's offers `new session` and `new with worktree`; a plain group's is a direct "new session here" button.

## Starting work in a new worktree

There are two entry points sharing one confirm step: the `new with worktree` button beside the typed path, and `new with worktree` in a repository group's `+` menu. Both need a repository, so the sheet first asks the hub for that repository's listing and uses the real root rather than whatever path was typed.

The sheet is one editable field, prefilled with a slug derived from the repository name and sanitized to lowercase letters, digits, dots, underscores and dashes. A live preview names the exact directory and `pixip/<slug>` branch, and a hint says the branch comes from the repository's current `HEAD`.

Submitting closes the sheet and opens the new-session route before git runs: the client pushes `#new`, paints `new session` with `starting…` and a disabled composer, and sends one `create` frame carrying the cwd and `{branch}`. The hub creates the tree, spawns Pi there, and the `opened` frame replaces the placeholder. A failure — not a repository, an existing branch, git's own error — paints on the placeholder with a way back, and no session is left behind.

An existing branch is caught twice. The sheet checks its fetched listing and, on a collision, stays open with `branch pixip/<slug> already exists; suggested …` and the next free suffix (`base-2`, `base-3`, …). If another create wins the race, git's failure surfaces on the pending session. A direct create through the `create` frame or `POST /api/sessions` may also pass `worktree: {branch, base?}`; the UI has no base control and always uses `HEAD`.

## Joining or switching to an existing worktree

Joining means putting a new agent into an existing tree. A worktree group's `+` → `new session` starts another agent in exactly that directory with no git operation; typing a worktree path in the new-session form does the same, and the next list detects it into the right group.

Switching is opening a session that is already there. Rows in a worktree child open like any other, and the footer and group header show its branch. The manage sheet for a worktree group opens with that group's tree first, so the tree you are looking at is the one you can act on.

The manage sheet shows the whole repository: the main tree, then every linked tree, each with its branch (or `main (repository)`), path, and changed-file count when dirty. A tree pixip neither created nor mounted is labelled `external` with its button disabled, because it belongs to you or another tool.

The directory picker is fenced to home: it lists real paths inside it and refuses a symlink escape. The worktree flow sits outside that fence by design — the directory derives from wherever the repository lives, and the typed path is unfenced. A worktree outside home therefore cannot be browsed to but can be typed, and its group is always on the dashboard.

## Sharing a directory with peers

Peers are a property of the directory, not the worktree: two sessions in the same realpath cwd are peers whether it is a main repository, linked tree, subdirectory or plain folder. Each session's info carries its peers (logical id and name), recomputed after create, stop, archive, child exit and import.

The client shows it once per open session, inline above the history: `another agent here:` or `other agents here:` with a tap-to-open button per peer and a dismiss control. The dismissal lasts for that visit; reopening brings the notice back, but a changed peer set does not resurrect a dismissal already made. The point is collision awareness: nothing locks files, and agents in one directory can overwrite each other's edits.

## Removing a worktree

Removal is deliberate, from a worktree group's `+` → `delete worktree` or a row's `delete`. The sheet states the contract: removal deletes the directory and git link, never the branch, and sessions keep their files. Three states can stop it.

A *referenced* tree — any listed session whose cwd is inside it — is refused before anything is touched. The sheet becomes `worktree in use`, names each session with state and cwd, and offers `open` or `actions`, so archiving or deleting references is one tap away; either releases the reference and leaves the tree.

A *dirty* tree is refused with its changed-file count. The button reads `continue`, and a second confirmation names the files at risk and reads `delete anyway`. Only that press sends `force: true`; the first never discards work.

An *external* tree — the main worktree, or a linked tree pixip neither created nor mounted — has no delete path. The row is disabled and labelled `external`, and even a forced REST or CLI request is refused; the main worktree is never removable.

Success closes the sheet, toasts the branch, and refreshes so the group disappears with the directory. A failed REST call is classified by `reason`: `dirty` reopens the force confirmation, `referenced` opens the in-use sheet, `external` toasts the refusal, anything else the message.

## Pruning stale trees

Pruning handles the opposite case: git still has an administrative record for a worktree whose directory vanished outside pixip. `pixip worktree prune [<repo-or-path>]` resolves the repository and runs `git worktree prune`, printing the repository. It never deletes a live tree or branch and is not part of teardown; it has no dashboard surface.

## The command line

The CLI has parity for listing and removal, plus prune, which is CLI-only.

```bash
pixip worktree list [<repo-or-path>] [--json]
pixip worktree remove <path> [--force]
pixip worktree prune [<repo-or-path>] [--json]
```

`list` defaults to the current directory, walks to the repository, and shows repo, path, branch, owner (`pixip` or `external`), live agent count, dirty state, and session names and states. It prefers a running daemon (`GET /api/worktrees` plus the session list) and otherwise instantiates the hub offline with startup trash cleanup disabled, so a read cannot purge the daemon's trash. `remove` takes the exact root, resolves it to a real path, and delegates to the same hub rules: REST `DELETE /api/worktrees` when a daemon owns the data directory, otherwise the offline hub. `--force` only overrides dirty; references and external trees always refuse. Safe refusals exit `2` and name what is in the way; usage, git and daemon errors exit `1`. No CLI verb creates a session in a worktree: that is the daemon's job.

## Archive, delete and restart

Archiving keeps worktree metadata in the index, so a restored session returns to its group. Deleting sends the session to trash and clears its reference; restoring brings the metadata back. Neither touches the directory. Restoring a session whose worktree is gone is allowed, and it fails like any missing-directory session instead of forgetting where it ran.

Restarting re-reads the index, so stopped rows keep `repo` and `worktree` and the tree looks the same. A live attach re-detects the worktree from cwd when the record has none, repairing sessions indexed before the metadata existed.

## Wireframes

### Grouped dashboard

```svg
<svg viewBox="0 0 360 330" width="100%" style="max-width:400px" role="img" aria-labelledby="wf70-tree">
  <title id="wf70-tree">Dashboard tree: repository parent with direct rows and two worktree child groups, one collapsed</title>
  <rect x="1" y="1" width="358" height="328" rx="12" fill="none" stroke="#888"/>
  <text x="16" y="26" font-size="12" fill="currentColor">sessions</text>
  <text x="330" y="26" font-size="11" fill="currentColor">⚙</text>
  <line x1="1" y1="38" x2="359" y2="38" stroke="#888"/>
  <rect x="10" y="48" width="340" height="26" rx="5" fill="none" stroke="#888"/>
  <text x="18" y="65" font-size="9" fill="#777">/path/to/project</text>
  <rect x="206" y="54" width="34" height="14" rx="4" fill="none" stroke="#888"/>
  <text x="211" y="64" font-size="7" fill="#777">browse</text>
  <rect x="246" y="54" width="26" height="14" rx="4" fill="none" stroke="#7aa2f7"/>
  <text x="251" y="64" font-size="7" fill="#7aa2f7">new</text>
  <rect x="276" y="54" width="68" height="14" rx="4" fill="none" stroke="#7aa2f7"/>
  <text x="280" y="64" font-size="7" fill="#7aa2f7">new with worktree</text>

  <text x="14" y="96" font-size="10" fill="currentColor">▾ ~/dev/project</text>
  <rect x="126" y="85" width="42" height="14" rx="4" fill="none" stroke="#888"/>
  <text x="131" y="95" font-size="7" fill="#777">main</text>
  <text x="190" y="96" font-size="8" fill="#777">5 sessions · 2 hidden</text>
  <text x="322" y="96" font-size="12" fill="#777">+</text>
  <rect x="14" y="104" width="332" height="34" rx="6" fill="none" stroke="#888"/>
  <text x="24" y="120" font-size="10" fill="currentColor">fixing the parser</text>
  <text x="24" y="132" font-size="8" fill="#777">busy · just now</text>
  <rect x="14" y="144" width="332" height="34" rx="6" fill="none" stroke="#888"/>
  <text x="24" y="160" font-size="10" fill="currentColor">docs pass</text>
  <text x="24" y="172" font-size="8" fill="#777">idle · 3m</text>

  <text x="30" y="198" font-size="10" fill="currentColor">▾ ~/pixip_worktrees/project/fix-a</text>
  <rect x="228" y="187" width="34" height="14" rx="4" fill="none" stroke="#9ece6a"/>
  <text x="232" y="197" font-size="7" fill="#9ece6a">fix-a</text>
  <text x="268" y="198" font-size="8" fill="#777">2 sessions</text>
  <text x="322" y="198" font-size="12" fill="#777">+</text>
  <rect x="30" y="206" width="316" height="34" rx="6" fill="none" stroke="#888"/>
  <text x="40" y="222" font-size="10" fill="currentColor">reconnect retry</text>
  <text x="40" y="234" font-size="8" fill="#777">busy · 1m · peer notice</text>

  <text x="30" y="260" font-size="10" fill="currentColor">▸ ~/pixip_worktrees/project/fix-b</text>
  <rect x="228" y="249" width="34" height="14" rx="4" fill="none" stroke="#9ece6a"/>
  <text x="232" y="259" font-size="7" fill="#9ece6a">fix-b</text>
  <text x="268" y="260" font-size="8" fill="#777">1 session</text>
  <text x="322" y="260" font-size="12" fill="#777">+</text>
  <text x="30" y="280" font-size="8" fill="#777">collapsed: worktree children stay hidden</text>

  <text x="14" y="308" font-size="10" fill="currentColor">▸ ~/scratch/notes</text>
  <text x="228" y="308" font-size="8" fill="#777">1 session</text>
  <text x="322" y="308" font-size="12" fill="#777">+</text>
</svg>
```

### New with worktree

```svg
<svg viewBox="0 0 360 300" width="100%" style="max-width:400px" role="img" aria-labelledby="wf70-create">
  <title id="wf70-create">New with worktree sheet: editable slug, directory and branch preview, collision notice</title>
  <rect x="1" y="1" width="358" height="298" rx="12" fill="none" stroke="#888"/>
  <text x="16" y="28" font-size="12" fill="currentColor">new with worktree</text>
  <text x="324" y="28" font-size="12" fill="#777">×</text>
  <text x="16" y="54" font-size="9" fill="#777">branch slug</text>
  <rect x="16" y="62" width="328" height="30" rx="6" fill="none" stroke="#7aa2f7"/>
  <text x="26" y="81" font-size="10" fill="currentColor">fix-a-2</text>
  <rect x="16" y="108" width="328" height="62" rx="6" fill="none" stroke="#888"/>
  <text x="26" y="128" font-size="8" fill="#777">directory</text>
  <text x="26" y="143" font-size="9" fill="currentColor">~/dev/pixip_worktrees/project/fix-a-2</text>
  <text x="26" y="161" font-size="8" fill="#777">branch</text>
  <text x="70" y="161" font-size="9" fill="#9ece6a">pixip/fix-a-2</text>
  <text x="16" y="192" font-size="8" fill="#777">Creates a branch from the repository's current HEAD.</text>
  <text x="16" y="204" font-size="8" fill="#777">The slug is editable; collisions get a suffix.</text>
  <rect x="16" y="216" width="328" height="22" rx="4" fill="none" stroke="#e0af68"/>
  <text x="24" y="231" font-size="8" fill="#e0af68">branch pixip/fix-a already exists; suggested pixip/fix-a-2</text>
  <rect x="16" y="254" width="112" height="26" rx="6" fill="none" stroke="#7aa2f7"/>
  <text x="28" y="271" font-size="9" fill="#7aa2f7">create worktree</text>
  <rect x="136" y="254" width="54" height="26" rx="6" fill="none" stroke="#888"/>
  <text x="148" y="271" font-size="9" fill="#777">cancel</text>
</svg>
```

### Manage and remove

```svg
<svg viewBox="0 0 360 420" width="100%" style="max-width:400px" role="img" aria-labelledby="wf70-remove">
  <title id="wf70-remove">Manage sheet listing main tree and worktrees, then a dirty-tree confirmation</title>
  <rect x="1" y="1" width="358" height="418" rx="12" fill="none" stroke="#888"/>
  <text x="16" y="26" font-size="12" fill="currentColor">worktrees · project</text>
  <text x="16" y="44" font-size="8" fill="#777">Removing a worktree deletes its directory and git link, never the branch.</text>
  <text x="16" y="56" font-size="8" fill="#777">Sessions keep their files.</text>

  <rect x="12" y="68" width="336" height="44" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="86" font-size="9" fill="currentColor">main (repository)</text>
  <text x="22" y="100" font-size="8" fill="#777">~/dev/project</text>

  <rect x="12" y="118" width="336" height="44" rx="6" fill="none" stroke="#7aa2f7"/>
  <text x="22" y="136" font-size="9" fill="currentColor">fix-a</text>
  <text x="22" y="150" font-size="8" fill="#777">~/dev/pixip_worktrees/project/fix-a</text>
  <rect x="286" y="130" width="52" height="20" rx="4" fill="none" stroke="#f7768e"/>
  <text x="292" y="144" font-size="8" fill="#f7768e">delete</text>

  <rect x="12" y="168" width="336" height="54" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="186" font-size="9" fill="currentColor">fix-b</text>
  <text x="22" y="200" font-size="8" fill="#777">~/dev/pixip_worktrees/project/fix-b</text>
  <text x="22" y="212" font-size="8" fill="#e0af68">3 changed files</text>
  <rect x="286" y="180" width="52" height="20" rx="4" fill="none" stroke="#f7768e"/>
  <text x="292" y="194" font-size="8" fill="#f7768e">delete</text>

  <rect x="12" y="228" width="336" height="44" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="246" font-size="9" fill="currentColor">release-notes</text>
  <text x="22" y="260" font-size="8" fill="#777">~/other/notes-tree</text>
  <rect x="286" y="240" width="52" height="20" rx="4" fill="none" stroke="#888"/>
  <text x="292" y="254" font-size="8" fill="#777">external</text>

  <rect x="12" y="286" width="336" height="30" rx="6" fill="none" stroke="#888"/>
  <text x="22" y="305" font-size="9" fill="#777">close</text>

  <line x1="1" y1="326" x2="359" y2="326" stroke="#888"/>
  <text x="16" y="346" font-size="11" fill="currentColor">delete worktree</text>
  <text x="16" y="364" font-size="9" fill="#cfc9e0">Delete the worktree for fix-b?</text>
  <text x="16" y="378" font-size="9" fill="#777">~/dev/pixip_worktrees/project/fix-b</text>
  <text x="16" y="392" font-size="8" fill="#e0af68">3 changed files would be lost.</text>
  <rect x="16" y="398" width="66" height="18" rx="4" fill="none" stroke="#f7768e"/>
  <text x="22" y="410" font-size="7" fill="#f7768e">continue</text>
  <rect x="90" y="398" width="44" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="96" y="410" font-size="7" fill="#777">cancel</text>
</svg>
```

### Create and remove decisions

```svg
<svg viewBox="0 0 720 300" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf70-flow">
  <title id="wf70-flow">Decision flow: create needs a git repo and free branch; remove needs no sessions, a pixip-owned tree and a clean or forced tree</title>
  <rect x="4" y="4" width="712" height="292" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">CREATE: NEW WITH WORKTREE</text>
  <rect x="18" y="38" width="120" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="56" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">typed cwd</text>
  <text x="26" y="69" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">or group +</text>
  <line x1="138" y1="58" x2="160" y2="58" stroke="#6f6889"/>
  <rect x="160" y="38" width="140" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="168" y="56" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">git repo?</text>
  <text x="168" y="69" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">show-toplevel</text>
  <line x1="300" y1="58" x2="322" y2="58" stroke="#6f6889"/>
  <rect x="322" y="38" width="150" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="330" y="56" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">slug / branch free?</text>
  <text x="330" y="69" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">suggest -2, -3</text>
  <line x1="472" y1="58" x2="494" y2="58" stroke="#6f6889"/>
  <rect x="494" y="38" width="208" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="502" y="56" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">worktree add · spawn</text>
  <text x="502" y="69" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">pixip/&lt;slug&gt; from HEAD</text>

  <rect x="160" y="92" width="140" height="34" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="168" y="113" font-family="ui-monospace, monospace" font-size="9" fill="#f7768e">refuse: not a repo</text>
  <line x1="230" y1="78" x2="230" y2="92" stroke="#6f6889"/>
  <rect x="322" y="92" width="150" height="34" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="330" y="113" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">keep sheet open</text>
  <line x1="397" y1="78" x2="397" y2="92" stroke="#6f6889"/>

  <line x1="18" y1="146" x2="700" y2="146" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="18" y="168" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">REMOVE: DELETE WORKTREE</text>
  <rect x="18" y="182" width="118" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="200" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">pick a tree</text>
  <text x="26" y="213" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">main tree excluded</text>
  <line x1="136" y1="202" x2="158" y2="202" stroke="#6f6889"/>
  <rect x="158" y="182" width="126" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="166" y="200" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">pixip-owned?</text>
  <text x="166" y="213" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">created or mounted</text>
  <line x1="284" y1="202" x2="306" y2="202" stroke="#6f6889"/>
  <rect x="306" y="182" width="122" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="314" y="200" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">sessions?</text>
  <text x="314" y="213" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">any listed cwd</text>
  <line x1="428" y1="202" x2="450" y2="202" stroke="#6f6889"/>
  <rect x="450" y="182" width="112" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="458" y="200" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">dirty?</text>
  <text x="458" y="213" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">status --porcelain</text>
  <line x1="562" y1="202" x2="584" y2="202" stroke="#6f6889"/>
  <rect x="584" y="182" width="118" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="592" y="200" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">worktree remove</text>
  <text x="592" y="213" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">git link gone, branch kept</text>

  <rect x="158" y="242" width="126" height="34" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="166" y="263" font-family="ui-monospace, monospace" font-size="9" fill="#f7768e">refuse: external</text>
  <line x1="221" y1="222" x2="221" y2="242" stroke="#6f6889"/>
  <rect x="306" y="242" width="122" height="34" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="314" y="263" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">in use: archive first</text>
  <line x1="367" y1="222" x2="367" y2="242" stroke="#6f6889"/>
  <rect x="450" y="242" width="112" height="34" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="458" y="263" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">force or abort</text>
  <line x1="506" y1="222" x2="506" y2="242" stroke="#6f6889"/>
  <text x="18" y="286" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">Stop, archive and delete never remove a tree; prune only clears git records for directories that already vanished.</text>
</svg>
```

## Port-relevant technical notes

Port notes only; the rules above are the contract.

### Identity and derivation

`WorktreeInfo` is `{repo, path, branch, pixipActive}` on `SessionInfo` (wire versioned). `repo` is the main root, present for every session in a repository including subdirectories; `worktree` exists only for a linked tree and always carries the tree root even for a subdirectory cwd. Both persist in `sessions.json` so stopped rows group after restart, and are re-derived on attach/import via `detectWorktree` then `detectRepo`.

Repository resolution runs `rev-parse --show-toplevel`, `--absolute-git-dir` and `--git-common-dir`; a linked tree is `gitDir !== commonDir`. Peer paths compare through `realCwd` (realpath, lexical fallback). The branch chip is a cached (~5 s) `rev-parse --abbrev-ref HEAD`, detached HEAD as short SHA, silent failure.

### The git boundary

`src/worktree.ts` is the only file that shells out to git, so the Rust port replaces one module. It uses `execFile("git", ["-C", cwd, …])` with a 15 s timeout and 1 MiB buffer. Slugs match `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,79})$`, additionally rejecting `..`, a trailing dot and `.lock`; a defensive `pixip/` prefix is stripped. `createWorktree` makes the parent and runs `worktree add -b pixip/<slug> <path> <base|HEAD>`. `listWorktrees` parses `worktree list --porcelain` and enriches each entry with `dirtyWorktree` (`status --porcelain` line count, untracked included). `isWorktreeMerged` (`merge-base --is-ancestor`) is in the boundary and tested but has no caller.

`pixipActive` is true for a `pixip/` branch, a managed path, or a mounted session. It is an ownership marker for removal, not a security boundary.

### Removal safety and idempotence

`hubWorktree.remove` resolves the slug, lists trees, and matches by full branch, bare slug, raw branch or managed path. It enforces, in order: main worktree or `!pixipActive` → `external`; any listed (non-archived) session with `worktree.path === target.path` → `referenced` with those sessions; dirty without `force` → `dirty`; otherwise `worktree remove [--force]`. The result union is the REST/CLI contract and maps to HTTP 409 `{error, reason, worktree, sessions?}`. A second call reports `unknown worktree`.

### REST, CLI and bind posture

`GET /api/worktrees?cwd=` and `DELETE /api/worktrees` (`{cwd, worktree: {branch}, force?}`) are ordinary dashboard routes and deliberately follow the server bind, including a LAN/Tailscale address; only `/api/refresh` is loopback-only, and no worktree route adds a token. Creation with a worktree goes through `POST /api/sessions` or the `create` frame, both normalized by `normalizeWorktreeRequest` (`{branch, base?}`; branch required).

The CLI shares the code: daemon present → `GET /api/worktrees` + `GET /api/sessions` for list and `DELETE /api/worktrees` for remove; no daemon → `new Hub({skipStartupTrash: true, idleMs: 0})` and the same hub methods. `remove` matches the exact tree by `realCwd` first, then lexical path. Safe refusals exit `2`; everything else `1`.

### Client grouping and pure modules

`src/client/sessionGroups.js` is DOM-free and unit-tested: `groupSessionTree` builds `repo`/`worktree`/`plain` nodes, synthesizes a parent from `worktree.repo`, sorts by newest activity then key, and exposes `groupActions` (`repo` → `new`/`newWorktree`, `worktree` → `new`/`delete`), `worktreeBranchLabel`, `slugifyWorktree`, `nextWorktreeSlug`, `worktreeBranchFor` and `worktreePathFor` (a `/`-only join mirroring `worktreePath`). `dashboardWorktree.js` is the only sheet code: it fetches `GET /api/worktrees`, checks branch collisions, and maps a failed DELETE's `reason` to a sheet state. Collapse state and pinning are `localStorage` keys `pixip.sessionGroups.collapsed` / `keepActive`. Peers come from the hub, not the client.

## Boundaries

Creating the session that the worktree hosts is the new-session/composer area's flow; this area only owns the worktree confirm and the git mutation. The group header's branch chip and the footer's branch text are session-info surfaces. The directory picker and its home fence are their own feature; this area only records how a worktree path relates to it. Archive and trash lifecycle belong to the dashboard/session areas; here only the reference release matters. Peer *coordination* does not exist: no locks, no merge tooling, no conflict detection.

## Sources

`src/worktree.ts`, `src/hubWorktree.ts`, `src/hubLive.ts` (`create`, `spawn`, `refreshPeers`), `src/hubStore.ts` (`gitBranch`, list/archive/restore), `src/hubSession.ts` (import detection), `src/hub.ts`, `src/wire.ts`, `src/server.ts` (worktree and session routes), `src/client/sessionGroups.js`, `src/client/dashboardWorktree.js`, `src/client/dashboardList.js`, `src/client/session.js`, `src/client/sessionView.js`, `src/client/dashboardPicker.js`, `bin/pixip.ts` (`worktree list/remove/prune`), `README.md` (Worktrees), `ARCHITECTURE.md` (Worktrees, repo groups and peers; UI strategy), `test/worktree.test.ts`, `test/worktree-hub.test.ts`, `test/worktree-routes.test.ts`, `test/worktree-cli.test.ts`, `test/sessionGroups.test.js`, `test/branch-hub.test.ts`, `test/directoryPicker.test.js`.

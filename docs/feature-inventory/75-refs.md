# References

A reference is a stable textual pointer to one message: a sent user message, a live message without an entry id yet, or an inbox message. The same `[pixip-ref=…]` bytes can be copied, inserted into the composer, sent to another agent, or resolved offline by `pixip ref`. Client and CLI share one grammar and one address. This area covers how a ref is written, chipped, copied, followed and refused.

## Contents

- [User stories](#user-stories)
- [What a reference points at](#what-a-reference-points-at)
- [The tag grammar](#the-tag-grammar)
- [Writing and copying](#writing-and-copying)
- [Transcript chips](#transcript-chips)
- [Composer chips](#composer-chips)
- [Following a reference](#following-a-reference)
- [Resolving without the UI](#resolving-without-the-ui)
- [Failure paths](#failure-paths)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want a reference in a sent message to read as a chip, not punctuation.
- As a user, I want to copy a reference into another prompt or session and have it mean the same thing.
- As a user, I want to insert a reference without hand-typing the grammar.
- As a user, I want a chip to take me to its message, paging history when needed.
- As a user, I want an unresolved reference to degrade to readable text, not a dead control.
- As an operator, I want the CLI to resolve a reference exactly as the UI does, daemon stopped.
- As an agent, I want a pointer in prose to be copyable and resolvable without a second link syntax.

## What a reference points at

| Kind | Shape | Example |
| --- | --- | --- |
| history entry | `history/<logicalSessionId>/<entryId>` | `[pixip-ref=history/7c1e9a2b/3f9a1c]` |
| history live message | `history/<logicalSessionId>/msg:<role>:<timestamp>` | `[pixip-ref=history/7c1e9a2b/msg:assistant:1735689600123]` |
| inbox message | `inbox/<inboxMessageId>` | `[pixip-ref=inbox/6f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8]` |

A **history** ref addresses one transcript entry. The preferred form uses Pi's entry id, stable in the JSONL and carried by a snapshot block. The `msg:` form exists for a live-painted block before Pi assigns an entry id; it uses the same coverage key the hub derives for user and assistant messages. The entry id is the durable pointer once persisted.

The **session** component is mandatory. Pixip mints logical ids, so a fork or clone can copy entry ids without making one alone ambiguous; the logical id also keeps `history` and `inbox` apart. An **inbox** ref addresses one message by id, including an archived one; a deleted message leaves a tombstone, so the resolver can say "deleted" rather than "unknown".

There is **no session-only ref, file kind, URL kind or bare-address alias**. A file path, attachment path and URL are plain text; the session is a component, not a target. A ref is always one bracketed tag, never a Markdown link.

## The tag grammar

```text
[pixip-ref=history/<session>/<entry>]
[pixip-ref=history/<session>/msg:<role>:<timestamp>]
[pixip-ref=inbox/<id>]
```

Session, entry and inbox components use `[A-Za-z0-9._-]+`; role is a lowercase Pi role; timestamp is integer milliseconds. Brackets are required and the whole tag must match. A two-part history tag, capitalised role, negative or fractional timestamp, or a space inside an id is not a ref; it stays literal text in the transcript, composer and scanner. The narrowness is intentional: prose mentioning `pixip-ref` must not be swallowed. The grammar lives in `src/client/reftags.js`, loaded directly by the browser; `src/reftags.ts` is a typed re-export for hub, CLI and tests, not a second implementation. `docs/reftags.md` is the user-facing contract.

## Writing and copying

An agent writes a ref by emitting the tag as ordinary text. In assistant prose it does **not** automatically become a chip: assistant output is Markdown, and the chip placeholder path is for user text. The tag remains a pointer a human can copy, paste into a prompt, or hand to `pixip ref`.

On a transcript block, the corner action bar is the authoring surface. Every snapshot message with an entry id gets the bar; live blocks derive one from their message key. The `#` action inserts the tag into the composer, the default in an open session. If the composer is disabled, hidden or covered by a blocking inline surface, it copies instead and says `composer unavailable — ref tag copied`; it never sends, clears or reorders a draft.

The `…` menu carries **copy ref** (bare tag) and **copy with text** (tag plus a quoted excerpt). The excerpt is rendered text without speaker label or action bar, whitespace collapsed and capped at 50 characters. A user block's menu also offers **fork**, a transcript action outside this grammar. Inbox cards have a one-tap `#` that copies `[pixip-ref=inbox/<id>]`; there is no insertion from the dashboard, so pasting the copied tag is the path.

## Transcript chips

When a sent user message contains a valid tag, the renderer splices an inert placeholder into the escaped text and keeps the raw tag as its text. A decoration pass resolves each placeholder into an inline chip.

A resolved history chip shows source session, role, local time and the first eight words. A resolved inbox chip shows sender, purpose and a capped subject, with a dashed outline so the kind is visible. The raw tag is the hover title and accessible label.

The chip is display-only: tapping does not navigate, because following a reference is a composer action. If a tag cannot resolve, its placeholder becomes the literal `[pixip-ref=…]` text, never a dead button. A malformed tag never becomes a placeholder; it stays escaped prose.

## Composer chips

Typing or pasting a valid tag turns it into an inline chip. The editor is contenteditable wearing the textarea contract: each chip serializes back to its raw tag, so the wire, a restored draft and the CLI see the same bytes. Plain text around a chip is untouched.

Insertion from a transcript block appends the tag to the draft. An empty composer becomes exactly the bare tag; otherwise a newline goes only before the tag, with no leading newline when the draft already ends in one and no trailing newline or space. The caret lands after the tag, focus stays in the composer, and the rest of the draft is byte-identical. Inserting twice appends two tags and produces two chips.

A chip is atomic for editing. Clicking or pressing Enter/Space on the body primes it and reveals `×`; clicking elsewhere drops the prime. Removing with `×` removes the whole token, updates the empty state, refocuses the field and fires the normal input event. Deleting around a chip removes it as one unit rather than exposing brackets.

A chip whose target is not in the client's current data is faint, dashed and labelled `unresolved`. The tag is not discarded and the prompt still sends it; the chip is a warning, not a blocker. A later sessions frame or loaded entry can relabel it without rewriting the text. Labels are display metadata only and never alter the tag or add prompt prose.

## Following a reference

The composer chip owns navigation. A first tap primes the chip and exposes `×`. A second click on that same chip opens a confirm sheet titled `jump to message?` with **Jump** and **Cancel**. Any other click drops the prime, so a single tap never navigates. Unresolved or malformed chips never open the dialog.

**Jump** uses existing routes and frames. A history ref in the current session scrolls to the painted block and flashes it for about 1.5 s without changing layout. If the block is outside the loaded window, the client requests earlier windows until it is found or the start is reached. A ref in another session opens that session, waits for attach, then pages, scrolls and flashes the same way. An inbox ref opens the inbox page, not a message sheet.

There is no return-to-composer gesture, saved scroll offset or "back to origin" control. The user returns with normal scrolling or the existing newest-message action. If the session or entry is missing, paint never arrives or the load deadline expires, the chip toasts `message not found` and leaves the position alone.

## Resolving without the UI

`pixip ref <tag> [--json]` resolves a copied tag with no daemon. It reads the session index, JSONL, archive metadata, trash metadata and `inbox.json` directly, so it works with pixip stopped.

For a history tag it finds the logical session in the active index or archive/trash store, picks the JSONL containing the entry id or matching live message key, and reads backwards from the tail. Human output names kind, session, role, entry id when present, time, cwd and branch, then the text capped at 4 KB with a truncation note. An archived session is marked `(archived)`; a trashed session is reported as deleted.

For an inbox tag it reads `inbox.json`, including archived messages, and prints subject, purpose, sender and creation time before the body, also capped at 4 KB. `--json` emits a stable object with kind, tag, role, time, session summary, entry id, message key, text, truncation flag, subject, purpose and sender.

A valid but unresolved target — unknown session or entry, deleted session, unknown or deleted inbox message — exits `2`. A malformed tag, missing argument or wrong flag is a usage error and exits `1`. The CLI and UI share grammar and address but resolve from different sources: the UI uses live sessions, loaded windows and the inbox API, while the CLI uses the data directory alone and must understand archive and trash layouts. A target the UI cannot label yet may still resolve with the CLI, and vice versa.

## Failure paths

| Situation | Transcript | Composer | CLI |
| --- | --- | --- | --- |
| Malformed or non-ref text | escaped prose | plain text | usage error, exit 1 |
| Target not loaded yet | literal tag | `unresolved` chip | resolves from JSONL |
| Unknown session or entry | literal tag | `unresolved` chip, still sends | exit 2, unknown |
| Archived session | resolves with name | resolves with name | resolves, `(archived)` |
| Deleted session | literal tag | `unresolved` chip | exit 2, was deleted |
| Inbox archived | resolves | resolves | resolves |
| Inbox deleted | literal tag | `unresolved` chip | exit 2, was deleted |

A ref from another pixip data directory is unknown: the address is local, not a global URL. A session in another repository still resolves if it is in the same data directory; output names its cwd and branch. Archive keeps the JSONL and metadata for restore or lookup. Delete leaves the active set and a bounded tombstone, so a copied ref produces a clear refusal instead of looking like a typo.

## Wireframes

Panel 1 is an inert transcript chip; 2 and 3 show the composer's two-step gesture and confirm sheet; 4 shows copy; 5 shows the unresolved fallback.

<svg viewBox="0 0 780 250" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-label="Reference surfaces: transcript chip, primed composer chip, jump confirmation, copy menu and unresolved fallback">
  <rect x="4" y="4" width="772" height="242" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">ONE REFERENCE · FIVE SURFACES</text>

  <rect x="18" y="38" width="142" height="192" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">1 · TRANSCRIPT</text>
  <rect x="28" y="68" width="122" height="58" rx="7" fill="#16141f" stroke="#322b45"/>
  <text x="36" y="85" font-family="ui-monospace, monospace" font-size="8" fill="#7aa2f7">you</text>
  <rect x="36" y="94" width="104" height="18" rx="9" fill="#241f33" stroke="#322b45"/>
  <text x="43" y="107" font-family="ui-monospace, monospace" font-size="6" fill="#cfc9e0">dev · assistant · 09:14 · fix…</text>
  <text x="28" y="148" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">inert display-only chip</text>
  <text x="28" y="166" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4"># inserts</text>
  <text x="28" y="180" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">… copies</text>
  <text x="28" y="204" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">fork on user blocks</text>

  <rect x="168" y="38" width="142" height="192" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="178" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">2 · PRIMED</text>
  <rect x="178" y="68" width="122" height="54" rx="7" fill="#16141f" stroke="#322b45"/>
  <rect x="186" y="88" width="98" height="18" rx="9" fill="#241f33" stroke="#7aa2f7"/>
  <text x="193" y="101" font-family="ui-monospace, monospace" font-size="6" fill="#e7e3f2">dev · assistant · 09:14</text>
  <text x="280" y="101" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">×</text>
  <text x="178" y="148" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">first tap primes</text>
  <text x="178" y="162" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">no navigation yet</text>
  <text x="178" y="184" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">× removes the tag</text>
  <text x="178" y="204" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">serializes back to raw</text>

  <rect x="318" y="38" width="142" height="192" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="328" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">3 · JUMP</text>
  <rect x="328" y="68" width="122" height="84" rx="7" fill="#16141f" stroke="#322b45"/>
  <text x="336" y="85" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">jump to message?</text>
  <rect x="336" y="98" width="46" height="20" rx="6" fill="#7aa2f7"/>
  <text x="348" y="112" font-family="ui-monospace, monospace" font-size="7" fill="#1a1626">Jump</text>
  <rect x="390" y="98" width="46" height="20" rx="6" fill="#241f33" stroke="#322b45"/>
  <text x="401" y="112" font-family="ui-monospace, monospace" font-size="7" fill="#cfc9e0">Cancel</text>
  <text x="328" y="176" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">second click confirms</text>
  <text x="328" y="196" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">scroll + 1.5 s flash</text>
  <text x="328" y="212" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">inbox → inbox page</text>

  <rect x="468" y="38" width="142" height="192" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="478" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">4 · COPY</text>
  <rect x="478" y="68" width="122" height="58" rx="7" fill="#16141f" stroke="#322b45"/>
  <text x="486" y="85" font-family="ui-monospace, monospace" font-size="6" fill="#e7e3f2">[pixip-ref=history/7c1e]</text>
  <text x="486" y="101" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">bare = portable</text>
  <text x="486" y="116" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">+text = 50-char excerpt</text>
  <text x="478" y="152" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">inbox # always copies</text>
  <text x="478" y="174" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">paste into composer</text>
  <text x="478" y="190" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">or pass to pixip ref</text>

  <rect x="618" y="38" width="142" height="192" rx="9" fill="#1d1a29" stroke="#322b45"/>
  <text x="628" y="56" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">5 · NO TARGET</text>
  <rect x="628" y="68" width="122" height="54" rx="7" fill="#16141f" stroke="#322b45"/>
  <text x="636" y="85" font-family="ui-monospace, monospace" font-size="6" fill="#9b93b4">[pixip-ref=history/gone/e1]</text>
  <text x="636" y="101" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">literal text</text>
  <text x="636" y="116" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">never a dead control</text>
  <rect x="628" y="132" width="122" height="18" rx="9" fill="#241f33" stroke="#6f6889" stroke-dasharray="3 3"/>
  <text x="636" y="145" font-family="ui-monospace, monospace" font-size="6" fill="#6f6889">unresolved · still sends</text>
  <text x="628" y="174" font-family="ui-monospace, monospace" font-size="7" fill="#9b93b4">late frame relabels</text>
  <text x="628" y="194" font-family="ui-monospace, monospace" font-size="7" fill="#f7768e">CLI exit 2</text>
  <text x="628" y="210" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">malformed: exit 1</text>
</svg>

Assistant prose is readable and copyable but not automatically chipped; a user-message or composer tag follows the chip path.

<svg viewBox="0 0 800 450" width="100%" style="display:block;width:100%;max-width:800px;height:auto" role="img" aria-label="Decision flow: a written or copied tag is scanned, parsed and resolved; success becomes a chip with jump and copy, failure stays literal text or becomes an unresolved chip">
  <rect x="4" y="4" width="792" height="442" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">FROM TEXT TO TARGET · ONE GRAMMAR, TWO RESOLVERS</text>

  <rect x="300" y="38" width="200" height="40" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="318" y="62" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">tag written or copied</text>
  <line x1="400" y1="78" x2="400" y2="96" stroke="#6f6889"/>
  <polygon points="400,96 530,126 400,156 270,126" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="331" y="130" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">where does it live?</text>

  <line x1="270" y1="126" x2="235" y2="126" stroke="#6f6889"/>
  <rect x="30" y="100" width="205" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="40" y="119" font-family="ui-monospace, monospace" font-size="8" fill="#9b93b4">assistant prose</text>
  <text x="40" y="134" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">stays Markdown · copy it</text>

  <line x1="530" y1="126" x2="565" y2="126" stroke="#6f6889"/>
  <rect x="565" y="100" width="210" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="575" y="119" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">user text or composer</text>
  <text x="575" y="134" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">scan for exact tags</text>

  <line x1="670" y1="152" x2="670" y2="168" stroke="#6f6889"/>
  <polygon points="670,168 795,198 670,228 545,198" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="619" y="202" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">parse exact?</text>

  <line x1="545" y1="198" x2="510" y2="198" stroke="#6f6889"/>
  <text x="516" y="191" font-family="ui-monospace, monospace" font-size="7" fill="#f7768e">no</text>
  <rect x="320" y="176" width="190" height="44" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="330" y="194" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">literal text</text>
  <text x="330" y="208" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">never swallowed or a button</text>

  <line x1="670" y1="228" x2="670" y2="248" stroke="#6f6889"/>
  <text x="676" y="242" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">yes</text>
  <polygon points="670,248 795,278 670,308 545,278" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="615" y="282" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">resolve target?</text>

  <line x1="545" y1="278" x2="510" y2="278" stroke="#6f6889"/>
  <text x="516" y="271" font-family="ui-monospace, monospace" font-size="7" fill="#f7768e">no</text>
  <rect x="320" y="256" width="190" height="44" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="330" y="274" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">safe fallback</text>
  <text x="330" y="288" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">literal tag / unresolved · CLI exits 2</text>

  <line x1="670" y1="308" x2="670" y2="326" stroke="#6f6889"/>
  <text x="676" y="322" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">yes</text>
  <rect x="550" y="326" width="225" height="56" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="560" y="345" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">chip</text>
  <text x="560" y="360" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">label · jump · copy ref · copy with text</text>
  <text x="560" y="373" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">same bytes reach the CLI</text>

  <line x1="24" y1="408" x2="776" y2="408" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="34" y="427" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">pixip ref = sessions.json + JSONL + archive/trash meta + inbox.json · browser = live frames · same grammar</text>
</svg>

## Port-relevant technical notes

Port notes only; the rules above are the contract.

### One grammar, no copies

`src/client/reftags.js` owns `REF_TAG_SOURCE` and the only regexes. `formatRefTag` returns `null` for an invalid structure, `parseRefTag` returns `null` unless the trimmed input is exactly one tag, and `scanRefTags` returns ordered `{ref, tag, start, end}` matches without throwing. `messageKey` must agree with `coverageKey()`/`coverageKeys()` in `src/jsonl.ts`; a test imports both. `refForEntry` prefers an entry id, then the live key. `src/reftags.ts` is only a typed re-export. A rewrite must keep one implementation or deliberately version and migrate the grammar, because a copied regex is how two places drift.

The strict charset is part of the wire contract: ids `[A-Za-z0-9._-]+`, role `[a-z][a-z0-9]*`, timestamp digits. `renderUserText` scans the HTML-escaped string, safe because escaping only emits entities the grammar cannot contain; it splices placeholders and keeps the raw tag visible until decoration.

### Addressing, resolution and jumps

A history ref needs both logical session and entry key. Entry ids alone are ambiguous after fork or clone because both JSONLs can carry the same ids. The live key exists because an entry can be painted before persistence; it matches the hub coverage key and is found by scanning entries backwards. The CLI reads from the tail with `WINDOW_BYTES`, growing to `FULL_ENTRY_BYTES`, and uses `transcriptEntries`/`parseEntries` rather than a second parser.

`src/refResolve.ts` defines `ResolvedRef` and `RefResolutionError` (exit `2`). History resolution checks the active hub list, then `<data-dir>/archive/<dir>/meta.json`, then trash metadata; the archive record chooses the stored file. A trashed id is reported as deleted, not unknown. Inbox resolution uses `InboxStore.all()` and `tombstones()`. Text is capped at `REF_TEXT_CHARS = 4096` with the omitted count appended; this is not a JSONL edit.

The client resolver in `reftagResolve.js` checks loaded `state.entries` or the painted block, then cached sessions, then a name-only chip when the sessions frame knows the session. An inbox tag triggers a cached `/api/inbox?all=1&filter=all` fetch keyed by unread/total/newest. A valid entry outside the loaded window must not become `unresolved`, because the jump must remain available.

`reftagJump.js` uses only existing routes and frames. A cross-session ref sets the URL hash, waits for attach (15 s), pages with `earlier {before}` until the entry is known or the start is reached (20 s), waits for paint (5 s), then scrolls and flashes for 1.5 s. Polling is 80 ms. A missing block ends in `message not found`, never a half-completed jump. No protocol field was added.

`composerEditor.js` installs textarea-compatible `value`, `disabled` and `setSelectionRange` over contenteditable. `readComposer` serializes chips back to raw tags; `renderComposer` converts complete tags and leaves malformed text alone; caret coordinates are computed against serialized text. `appendRefTag`/`removeRefTag` are pure helpers in `reftagText.js`. The 50-character excerpt, 8-word history label and 60-character inbox subject are display caps.

`bin/pixip.ts` parses one positional tag with `parseRefArg`, which treats malformed input as a usage error (`1`) and delegates valid tags to `resolveRef`. `formatRef` is human output; `--json` serializes `ResolvedRef`. The command builds an offline hub and shuts it down in `finally`. Unknown/deleted targets are `2`; a truncated body still exits `0` with `truncated: true`.

## Boundaries

This area owns the ref grammar, target address, chip labels and resolution, composer insertion/removal semantics, jump behaviour and the offline CLI contract. Transcript reading owns block painting and the rest of the action bar; composer input owns sending, drafts and the editor facade; inbox reports owns the card list, archive/delete and report attachment. `fork` and `copy with text` are actions beside refs, not part of the grammar. No port verdicts.

## Sources

`src/client/reftags.js`, `reftagResolve.js`, `reftagJump.js`, `reftagActions.js`, `reftagText.js`, `composerEditor.js`, `render.js`, `transcript.js`, `frames.js`, `inbox.js`, `app.js`, `transcript.css`, `composer.css`, `src/reftags.ts`, `src/refResolve.ts`, `src/jsonl.ts`, `src/inbox.ts`, `src/sessionIndex.ts`, `bin/pixip.ts`, `docs/reftags.md`, `README.md` (Refs), `test/reftags.test.ts`, `test/ref-cli.test.ts`, `test/render.test.js`, and the closed `chipwitch` tickets `00-ref-grammar`, `10-ref-copy-affordance`, `20-composer-ref-chips`, `30-transcript-ref-chips`, `40-ref-cli`, `50-ref-insert-default`, `60-reftag-chip-navigation` and `70-inline-composer-ref-chips`.

# Inbox and reports

The inbox is where an agent leaves something for the user without keeping a session open: a subject, a body, a purpose and sometimes an HTML report. A quiet bar on the dashboard says a message exists without interrupting a session; the inbox page is where messages are read, filtered, archived or deleted, and a tap on a sender starts a reply with the composer prefilled. HTML reports open as their own validated document, so a phone can scroll a long report with locally served images and no script can run.

## Contents

- [User stories](#user-stories)
- [How a message reaches the inbox](#how-a-message-reaches-the-inbox)
- [The dashboard bar](#the-dashboard-bar)
- [The inbox page](#the-inbox-page)
- [Unread, filtering and archiving](#unread-filtering-and-archiving)
- [Replying to the sender](#replying-to-the-sender)
- [Reading a report](#reading-a-report)
- [Writing a report](#writing-a-report)
- [The report sandbox](#the-report-sandbox)
- [Empty and no-extension states](#empty-and-no-extension-states)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## User stories

- As a user, I want a quiet bar to tell me a message exists and how urgent it claims to be, without interrupting my session.
- As a user, I want one tap from that bar to my unread or urgent messages, and to archive what I have handled.
- As a user, I want to reply to a message by starting a session with the context already in the composer.
- As a user, I want to open a report on my phone and scroll it comfortably, with images that work without the internet.
- As a user, I want to trust that a report cannot run scripts, submit forms or load remote content.
- As a user who has not installed the agent tool yet, I want the bar to stay out of the way instead of showing dead chrome.

## How a message reaches the inbox

An agent posts with `inbox_send`; a shell can post with `pixip inbox send`. Both go to the hub, which owns the inbox file and attributes the message to the calling session (`PIXIP_SESSION_ID`) or labels it `local shell`. The message then belongs to the data directory, not to that session: closing or deleting the sender leaves it readable.

Every message has a subject, a body, a creation time, a sender snapshot (name, cwd, branch, Pi id) and one of four purposes: `attention-needed`, `deliverable`, `extra-info`, `no-rush`. Subjects cap at 200 characters and bodies at 8 KB. Messages do not expire; the store holds at most 200, evicting archived first, then read, then the oldest unread.

Sender *status* is not stored. It is resolved from the dashboard's live sessions and archive on each read, so a message says `running`, `idle`, `stopped`, `archived` or `deleted`. The posting tool and its error strings are the bundled extension's surface, not this one.

## The dashboard bar

The bar is pinned to the bottom of the dashboard list, and only there. It shows the newest non-archived message: subject on one line and a flattened body preview on the next, both ellipsised, with an unread badge on the right. No subject reads `untitled message`, an empty body falls back to `from <sender>`, and an empty inbox says `no messages yet`.

The badge is blank at zero, counts to `99` then `99+`, and its label reads `Inbox · 3 unread` or `Inbox · 5 message(s)`. Its colour is capacity, not urgency: accent normally, warning at half full, error at 99 %, with a toast at each threshold once per browser suggesting archive or delete. Purpose is not colour-coded here; a bar that shouted on every `attention-needed` message would stop being quiet.

The bar hides while the session view or inbox page is open, and on the dashboard when the inbox has no non-archived message and no agent has loaded the `pixip-inbox` extension. That rule keeps a fresh install from showing chrome for a channel nobody can use yet. A message or an extension announcement brings the bar back without a reload. It never opens a sheet: a tap sets `#inbox`, which is a real page.

## The inbox page

`#inbox` replaces the dashboard rather than covering it. The header reads `inbox` with `durable messages` underneath, `‹` returns to the list, and composer, footer, dock and stop are hidden because there is nothing to type into here. The page paints `loading…`, then the toolbar and list, or a toast if the request failed.

The toolbar holds filter chips: `all`, `unread`, one per purpose (`attention`, `deliverable`, `extra info`, `no rush`) and `archived (n)`. `all` and `unread` are a pair, a purpose chip toggles and only one is active, and the archived chip switches the whole list to archived messages. When the active view has unread messages, `mark all read` sits on the right.

A card shows sender (`name · 8-char id`), purpose pill and sender status; then subject, a meta line with relative time, `read`/`unread` and `archived`, and the body. Collapsed shows the first line capped at 180 characters; expanded shows the whole body with whitespace preserved. Unread cards get an accent left border. Tapping the header, subject or preview expands and marks read; tapping the open body selects text instead, and a drag selection never toggles the card.

The action row has `view report` when attached, a copy-ref button yielding `[pixip-ref=inbox/<id>]`, `archive` or `restore`, and `delete`. Delete asks in a sheet quoting the subject. Archive, restore and delete toast, and archive and delete reload the snapshot so counts stay honest.

The message list is the only scroller, at full height under the toolbar, so a long message scrolls instead of clipping inside a fixed box. The column is centred with a 760 px cap and gains no second column when the window widens. The page is a snapshot: a live frame updates the bar, but a message arriving while the page is open appears on the next visit.

## Unread, filtering and archiving

Unread is derived: a message is unread when `readAt` is empty, the unread count excludes archived messages and the total counts everything. The summary and the page's list both send those numbers, and the client keeps the newest message and extension flag across a list response because that response does not carry them.

The filters compose: archived toggle, then `all` versus `unread`, then at most one purpose; the list sorts newest first. Expanding an unread message marks it read without a reload, and `mark all read` marks every active unread message at once.

Archiving is a state, not deletion: the message leaves the active list, stops counting as unread, and can be restored. Deleting removes it and records a bounded tombstone, so a copied ref can say `deleted` instead of `unknown`. Deleting or evicting the last message that references a report also removes that report.

## Replying to the sender

The sender line is a button only while the dashboard can still address the session. Tapping it opens the session and puts `[inbox <8-char id>] ` in the composer, focused and unsent. The prefix is the whole mechanism: the agent sees which message is being answered, and the user can add anything or discard it. A sender that is gone, archived or deleted renders as plain text, so a dead address never looks live while the message stays readable.

## Reading a report

A message with a report shows `view report`, opening `/reports/<name>/` in a new tab with `noopener noreferrer`. There is no in-app viewer and no dashboard route.

The report is a standalone document served by the hub: `index.html` at the slash, a bare `/reports/<name>` redirect, and one top-level file per asset. Relative URLs work (`chart.png`, `theme.css`), and every asset comes from the report's own directory on the same daemon, so images and fonts load without the internet. Responses are `no-store` with `nosniff`, `no-referrer` and a locked-down CSP, on the same trust boundary as the dashboard: there is no report authentication.

On a phone the report owns the viewport: no pixip chrome, no transcript text-size preference, ordinary document scrolling, and the back gesture returns to the inbox. On a wide screen the report decides its own layout; pixip adds no rail or second column. Reports are shared by URL and can be attached to several messages; the card is the only place the link appears.

## Writing a report

Reports are agent-only: no CLI command and no browser editor. `inbox_report` is the only writing path, with `new`, `write`, `add_asset`, `remove_asset` and `show`.

`new` creates a directory under `<data-dir>/reports/`; `add_asset` copies one absolute local path in and returns the top-level filename; `write` validates the whole document before replacing `index.html`; `show` returns the exact current HTML, assets, attachment state and URL; `remove_asset` refuses while HTML or CSS still references the file. A report must be written before it can be sent, and a message references it by `reportName`.

Overwrites are concurrency-safe: when HTML exists, `write` requires `existingHtml` to equal the current document exactly and otherwise refuses with a prompt to call `show` and retry. The first write omits it. Lifecycle is automatic: attaching marks the report attached, a never-attached draft is swept after 24 hours, and a report whose last referencing message is deleted or evicted is removed at once.

## The report sandbox

Reports are agent-authored HTML shown in the user's browser, so they are untrusted. The hub parses each document and SVG with `parse5` against allowlists of structural tags — headings, paragraphs, tables, lists, code, figures, sections, inline formatting, images, links, details, inert form markup, SVG — and of attributes.

Rejected: scripts, iframes, objects and embeds, event handlers such as `onclick`, `javascript:` URLs, `meta` refresh and other `http-equiv` uses, external and root-relative resources, form `action`/`method`/`target`/`enctype`, submit/reset/file inputs, and buttons that are not `type="button"`. CSS refuses `@import`, `expression()`, `behavior`, `-moz-binding` and `javascript:`, and `url()` may name only a top-level asset or a small base64 image. SVG `<use>` may reference only same-document ids. External `<a href>` navigation is allowed; remote images must be added as assets.

Limits are 1 MiB for `index.html`, 1 MiB per asset and 10 MiB per report, with raster images checked by magic bytes. Serving is dumb because files were already validated, but the CSP still says `script-src 'none'`, `object-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `connect-src 'none'`, with images, styles and fonts from `self` and `data:`. Two layers, because reports render on the dashboard's origin.

The trade-off is explicit: no interactive reports beyond `<details>` and inert controls, and no script-drawn charts. A chart arrives as an image asset.

## Empty and no-extension states

A fresh data directory has no inbox file, no messages and no bar. The page still works at `#inbox`, showing `no messages`, or `no archived messages` under that filter. Nothing hints that the channel exists until the `pixip-inbox` extension loads in any Pi child; the daemon remembers the announcement in memory, so a restart re-learns it, and the bar then appears empty rather than absent.

An inbox with only archived messages also hides the bar unless that extension flag is set. Those messages remain reachable by the route, which is acceptable for a state the user created by archiving.

## Wireframes

### Dashboard bar

```svg
<svg viewBox="0 0 360 236" width="100%" style="max-width:400px" role="img" aria-labelledby="wf60-bar">
  <title id="wf60-bar">Dashboard list with the pinned inbox bar: subject, preview, unread badge</title>
  <rect x="1" y="1" width="358" height="234" rx="12" fill="none" stroke="#888"/>
  <text x="16" y="26" font-size="12" fill="currentColor">sessions</text>
  <text x="318" y="26" font-size="12" fill="currentColor">⚙</text>
  <line x1="1" y1="38" x2="359" y2="38" stroke="#888"/>
  <rect x="12" y="52" width="336" height="42" rx="7" fill="none" stroke="#888"/>
  <text x="24" y="70" font-size="10" fill="currentColor">~/dev/sin/pixip</text>
  <text x="24" y="84" font-size="9" fill="#777">2 sessions · 1 hidden</text>
  <rect x="12" y="102" width="336" height="38" rx="7" fill="none" stroke="#888"/>
  <text x="24" y="118" font-size="10" fill="currentColor">fix transcript scroll</text>
  <text x="24" y="132" font-size="9" fill="#777">idle · 4m</text>
  <rect x="12" y="148" width="336" height="38" rx="7" fill="none" stroke="#888"/>
  <text x="24" y="164" font-size="10" fill="currentColor">migration report</text>
  <text x="24" y="178" font-size="9" fill="#777">stopped · 2h</text>
  <rect x="0" y="194" width="360" height="42" fill="#16141f" stroke="#322b45"/>
  <text x="14" y="212" font-size="12" fill="#9b93b4">✉</text>
  <text x="34" y="211" font-size="10" fill="#e7e3f2">Review the migration</text>
  <text x="34" y="224" font-size="9" fill="#6f6889">staging build is green; logs at /tmp/deploy.log</text>
  <circle cx="338" cy="215" r="10" fill="#7aa2f7"/>
  <text x="332" y="219" font-size="10" fill="#16141f">2</text>
</svg>
```

One tap on the bar opens the page; the badge is the unread count, and the bar is absent when there is nothing to show.

### Inbox page, filters and an expanded message

```svg
<svg viewBox="0 0 360 600" width="100%" style="max-width:400px" role="img" aria-labelledby="wf60-page">
  <title id="wf60-page">Inbox page: back header, filter chips, unread and read cards, one expanded with actions</title>
  <rect x="1" y="1" width="358" height="598" rx="12" fill="none" stroke="#888"/>
  <text x="14" y="28" font-size="12" fill="currentColor">‹</text>
  <text x="32" y="28" font-size="12" fill="currentColor">inbox</text>
  <text x="32" y="40" font-size="8" fill="#777">durable messages</text>
  <line x1="1" y1="50" x2="359" y2="50" stroke="#888"/>
  <rect x="12" y="62" width="40" height="22" rx="11" fill="none" stroke="#7aa2f7"/>
  <text x="22" y="77" font-size="9" fill="#7aa2f7">all</text>
  <rect x="58" y="62" width="54" height="22" rx="11" fill="none" stroke="#888"/>
  <text x="67" y="77" font-size="9" fill="#777">unread</text>
  <rect x="118" y="62" width="66" height="22" rx="11" fill="none" stroke="#888"/>
  <text x="126" y="77" font-size="9" fill="#777">attention</text>
  <rect x="190" y="62" width="72" height="22" rx="11" fill="none" stroke="#888"/>
  <text x="198" y="77" font-size="9" fill="#777">deliverable</text>
  <rect x="12" y="90" width="86" height="22" rx="11" fill="none" stroke="#888"/>
  <text x="20" y="105" font-size="9" fill="#777">archived (1)</text>
  <text x="276" y="105" font-size="9" fill="#777">mark all read</text>

  <rect x="12" y="122" width="336" height="120" rx="8" fill="none" stroke="#7aa2f7"/>
  <text x="22" y="140" font-size="9" fill="#7aa2f7">fix transcript scroll · a1b2c3d4</text>
  <rect x="168" y="130" width="62" height="14" rx="7" fill="none" stroke="#f7768e"/>
  <text x="174" y="140" font-size="7" fill="#f7768e">ATTENTION</text>
  <text x="294" y="140" font-size="8" fill="#9ece6a">RUNNING</text>
  <text x="22" y="158" font-size="11" fill="currentColor">Transcript jumps on load</text>
  <text x="22" y="172" font-size="8" fill="#777">2m · unread</text>
  <text x="22" y="190" font-size="9" fill="#cfc9e0">load earlier keeps my place while output</text>
  <text x="22" y="203" font-size="9" fill="#cfc9e0">still streams.</text>
  <text x="22" y="222" font-size="8" fill="#6f6889">click header or preview to expand · tapping open body selects text</text>
  <rect x="12" y="226" width="60" height="14" rx="4" fill="none" stroke="#888"/>
  <text x="18" y="236" font-size="7" fill="#777">view report</text>

  <rect x="12" y="252" width="336" height="150" rx="8" fill="none" stroke="#888"/>
  <text x="22" y="270" font-size="9" fill="#7aa2f7">migration report · 9f8e7d6c</text>
  <text x="286" y="270" font-size="8" fill="#e0af68">STOPPED</text>
  <text x="22" y="288" font-size="11" fill="currentColor">Migration report</text>
  <text x="22" y="302" font-size="8" fill="#777">2h · read</text>
  <text x="22" y="320" font-size="9" fill="#cfc9e0">The staging run is green. Report attached.</text>
  <line x1="22" y1="330" x2="338" y2="330" stroke="#322b45"/>
  <rect x="22" y="340" width="58" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="28" y="352" font-size="7" fill="#777">view report</text>
  <rect x="86" y="340" width="52" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="92" y="352" font-size="7" fill="#777">copy ref</text>
  <rect x="144" y="340" width="52" height="18" rx="4" fill="none" stroke="#888"/>
  <text x="150" y="352" font-size="7" fill="#777">archive</text>
  <rect x="202" y="340" width="46" height="18" rx="4" fill="none" stroke="#f7768e"/>
  <text x="208" y="352" font-size="7" fill="#f7768e">delete</text>
  <text x="22" y="376" font-size="8" fill="#6f6889">delete confirms in a sheet · archive and restore toast</text>

  <rect x="12" y="412" width="336" height="60" rx="8" fill="none" stroke="#888"/>
  <text x="22" y="430" font-size="9" fill="#7aa2f7">local shell · 0a1b2c3d</text>
  <text x="22" y="448" font-size="11" fill="currentColor">tests pass</text>
  <text x="22" y="462" font-size="8" fill="#777">1d · read</text>

  <text x="22" y="504" font-size="9" fill="#6f6889">the list is the only scroller; the column caps at 760 px</text>
  <text x="22" y="518" font-size="9" fill="#6f6889">and gains no second column when the window widens.</text>
  <text x="22" y="544" font-size="9" fill="#6f6889">a live frame updates the bar, not an open list;</text>
  <text x="22" y="558" font-size="9" fill="#6f6889">reopening #inbox reloads the snapshot.</text>
  <text x="22" y="584" font-size="9" fill="#6f6889">back ‹ returns to the dashboard list.</text>
</svg>
```

### Report on a phone and on a wide screen

```svg
<svg viewBox="0 0 720 360" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf60-report">
  <title id="wf60-report">Report document on a phone and on a wide screen, with local images and no pixip chrome</title>
  <rect x="6" y="8" width="250" height="344" rx="16" fill="none" stroke="#888"/>
  <text x="20" y="32" font-size="9" fill="#777">/reports/migration/</text>
  <text x="20" y="56" font-size="13" fill="currentColor">Migration report</text>
  <text x="20" y="76" font-size="9" fill="#cfc9e0">The staging run is green on all</text>
  <text x="20" y="89" font-size="9" fill="#cfc9e0">three services. One warning.</text>
  <rect x="20" y="102" width="222" height="80" rx="6" fill="none" stroke="#888"/>
  <text x="92" y="146" font-size="9" fill="#777">chart.png · local asset</text>
  <text x="20" y="204" font-size="9" fill="#cfc9e0">Latency stayed under the budget</text>
  <text x="20" y="217" font-size="9" fill="#cfc9e0">for the whole run.</text>
  <rect x="20" y="232" width="222" height="46" rx="5" fill="none" stroke="#888"/>
  <text x="28" y="250" font-size="8" fill="#777">service</text>
  <text x="120" y="250" font-size="8" fill="#777">p95</text>
  <text x="180" y="250" font-size="8" fill="#777">status</text>
  <text x="28" y="266" font-size="8" fill="currentColor">api</text>
  <text x="120" y="266" font-size="8" fill="currentColor">42 ms</text>
  <text x="180" y="266" font-size="8" fill="#9ece6a">green</text>
  <text x="20" y="304" font-size="8" fill="#6f6889">own viewport · own scroll ·</text>
  <text x="20" y="317" font-size="8" fill="#6f6889">no pixip header, composer or</text>
  <text x="20" y="330" font-size="8" fill="#6f6889">text-size preference</text>

  <rect x="286" y="8" width="428" height="344" rx="12" fill="none" stroke="#888"/>
  <text x="304" y="32" font-size="9" fill="#777">/reports/migration/ · wide</text>
  <text x="304" y="58" font-size="14" fill="currentColor">Migration report</text>
  <text x="304" y="80" font-size="9" fill="#cfc9e0">The staging run is green on all three services. One warning.</text>
  <rect x="304" y="94" width="250" height="96" rx="6" fill="none" stroke="#888"/>
  <text x="380" y="146" font-size="9" fill="#777">chart.png</text>
  <rect x="572" y="94" width="128" height="96" rx="6" fill="none" stroke="#888"/>
  <text x="582" y="112" font-size="8" fill="#777">key facts</text>
  <text x="582" y="130" font-size="8" fill="currentColor">3 services green</text>
  <text x="582" y="146" font-size="8" fill="currentColor">p95 42 ms</text>
  <text x="582" y="162" font-size="8" fill="currentColor">1 warning</text>
  <text x="304" y="216" font-size="9" fill="#cfc9e0">The report decides this layout in its own CSS; pixip adds no</text>
  <text x="304" y="230" font-size="9" fill="#cfc9e0">rail or second column of its own.</text>
  <line x1="304" y1="252" x2="700" y2="252" stroke="#322b45"/>
  <text x="304" y="274" font-size="8" fill="#6f6889">served with CSP script-src 'none' · object-src 'none' · frame-src 'none'</text>
  <text x="304" y="288" font-size="8" fill="#6f6889">form-action 'none' · connect-src 'none' · img/style/font from self and data:</text>
  <text x="304" y="302" font-size="8" fill="#6f6889">nosniff · no-referrer · no-store · no report auth</text>
  <text x="304" y="326" font-size="8" fill="#6f6889">relative assets work offline; remote images must be added as assets first.</text>
</svg>
```

### Flow: message in, decision out

```svg
<svg viewBox="0 0 720 320" width="100%" style="display:block;width:100%;max-width:720px;height:auto" role="img" aria-labelledby="wf60-flow">
  <title id="wf60-flow">Flow: message posted, bar shows unread, open page, read, archive or reply or open report, then restore or delete</title>
  <rect x="4" y="4" width="712" height="312" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">ONE MESSAGE, ONE QUIET PATH</text>
  <rect x="18" y="40" width="128" height="44" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="26" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">agent posts</text>
  <text x="26" y="72" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">inbox_send</text>
  <line x1="146" y1="62" x2="172" y2="62" stroke="#6f6889"/>
  <rect x="172" y="40" width="146" height="44" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="180" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">bar: subject + badge</text>
  <text x="180" y="72" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">dashboards get a frame</text>
  <line x1="318" y1="62" x2="344" y2="62" stroke="#6f6889"/>
  <rect x="344" y="40" width="120" height="44" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="352" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">tap · #inbox</text>
  <text x="352" y="72" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">page snapshot</text>
  <line x1="464" y1="62" x2="490" y2="62" stroke="#6f6889"/>
  <rect x="490" y="40" width="128" height="44" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="498" y="58" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">open a message</text>
  <text x="498" y="72" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">marks read · expands</text>
  <line x1="618" y1="62" x2="644" y2="62" stroke="#6f6889"/>
  <circle cx="660" cy="62" r="16" fill="#241f33" stroke="#bb9af7"/>
  <text x="655" y="66" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">?</text>

  <line x1="660" y1="78" x2="660" y2="96" stroke="#6f6889"/>
  <rect x="540" y="96" width="120" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="548" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">reply</text>
  <text x="548" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">prefill [inbox 8]</text>
  <line x1="660" y1="96" x2="660" y2="96" stroke="#6f6889"/>
  <rect x="394" y="96" width="120" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="402" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#7aa2f7">view report</text>
  <text x="402" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">new tab · sandboxed</text>
  <rect x="248" y="96" width="120" height="40" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="256" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">archive</text>
  <text x="256" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">leaves the active list</text>
  <rect x="102" y="96" width="120" height="40" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="110" y="114" font-family="ui-monospace, monospace" font-size="9" fill="#f7768e">delete</text>
  <text x="110" y="128" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">sheet confirms</text>

  <line x1="20" y1="158" x2="700" y2="158" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="20" y="180" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">WHAT THE STATE MEANS</text>
  <rect x="20" y="194" width="212" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="28" y="212" font-family="ui-monospace, monospace" font-size="9" fill="#9ece6a">readAt empty → unread</text>
  <text x="28" y="226" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">archived is excluded from unread</text>
  <rect x="242" y="194" width="212" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="250" y="212" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">archived → restore possible</text>
  <text x="250" y="226" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">the bar stays hidden if that is all</text>
  <rect x="464" y="194" width="236" height="46" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="472" y="212" font-family="ui-monospace, monospace" font-size="9" fill="#f7768e">deleted → tombstone</text>
  <text x="472" y="226" font-family="ui-monospace, monospace" font-size="8" fill="#6f6889">a copied ref says deleted, not unknown</text>
  <text x="20" y="266" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">no message is ever sent to the agent from this surface: reply only prefills the composer.</text>
  <text x="20" y="284" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">at 200 messages, eviction takes archived first, then read, then the oldest unread.</text>
  <text x="20" y="302" font-family="ui-monospace, monospace" font-size="9" fill="#6f6889">the report directory disappears with the last message that referenced it.</text>
</svg>
```

The bar is the entry, the page is a snapshot of the store, and every exit is a message state change except the two that leave the inbox — reply and report.

## Port-relevant technical notes

Port notes only; the rules above are the contract.

### Storage and ownership

`src/inbox.ts` owns `<data-dir>/inbox.json`: a versioned file with messages and a bounded tombstone list, written by temp file plus rename under one serialized read-modify-write chain. The hub is the only writer. The cap is 200, evicting archived → read → oldest unread (an unread eviction is logged); tombstones share the cap. Messages are normalized on load, so one malformed message drops while the rest survives. Bodies are bounded at 8 KB and subjects at 200 characters at write time.

`src/hubInbox.ts` joins messages with session status (logical and Pi id → `running`/`idle`/`stopped`/`archived`, else `deleted`) and broadcasts a small `inbox` frame with unread, total, limit, newest and an in-memory `extension` flag to every dashboard socket after each mutation. The flag is not on disk, so an uninstall cannot leave stale chrome. `frameInbox` is the only inbox frame shape; the page's list is REST.

### Routes and client state

`GET /api/inbox` takes `archived`, `all`, `filter` (`all`/`unread`/`read`) and `purpose`; mutations are `POST /api/inbox/read-all`, `POST /api/inbox/:id/read|archive|restore`, `DELETE /api/inbox/:id`, plus `POST /api/inbox` (send) and `POST /api/inbox/reports` (report actions). `--inbox-token`/`PIXIP_INBOX_TOKEN` adds an optional bearer check on the whole `/api/inbox` prefix, off by default.

The page is a route (`#inbox` → `showInboxPage`), not a sheet; it attaches the session-less dashboard socket, but paints from its own `viewState` and reloads only on navigation or mutation. `inboxModel.js` is pure and unit-tested: bar visibility, preview flattening, badge cap, capacity level and thresholds, filters, archived count, sender status, reply resolution and the `[inbox <8>] ` prefix. `inbox.js` is the DOM painter and uses `textContent` for every message field, so a body is never interpreted as HTML.

### Reports

`src/inboxReport.ts` owns `<data-dir>/reports/<name>/`: `index.html`, top-level assets and a `.pixip-report.json` marker with created/updated/attached timestamps. Names match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; asset names are a single safe filename from a fixed extension set. Writes are atomic. Validation is `parse5`-based with tag and attribute allowlists, magic-byte checks for raster assets and font signatures; `remove_asset` re-parses HTML, CSS and SVG to refuse a live reference, and `write` requires exact `existingHtml` on overwrite (409 otherwise). Serving is `GET /reports/<name>/` and `/reports/<name>/<asset>` (one top-level file), a 301 from the bare name, and `REPORT_CSP` plus `nosniff`, `no-referrer`, `no-store` in `src/server.ts`. `retain` runs after send and delete: it removes an unreferenced directory that was once attached or has been idle past 24 hours. The client only builds the report URL and the card link.

### Layout

The bar is fixed with `--safe-b` padding and a 760 px content cap, hidden with the `hidden` attribute so frames can restore it. The page reuses the sheet card styles and overrides the scroller in `list.css`: `#inbox-page` is a flex column capped at 760 px, `.inbox-list` is the only `overflow-y` scroller, and cards are `flex: 0 0 auto` so a long body is clipped by the list, not squeezed. Reports inherit none of this.

## Boundaries

Sending is the agent-facing side: the `inbox_send`/`inbox_report` tools, their help text and error strings belong to the bundled extensions. Message-to-session reference tags and their jump behaviour belong to the refs area; the card only copies the tag. The dashboard owns the list, the route and the bar's placement; the session view owns the composer that a reply prefills. Archived-session and trash management are dashboard concerns, not inbox states.

## Sources

`src/client/inbox.js`, `inboxModel.js`, `inbox.css` rules in `base.css`, `list.css`, `sheets.css`, `src/client/reftagActions.js`, `src/inbox.ts`, `src/inboxReport.ts`, `src/hubInbox.ts`, `src/server.ts`, `src/wire.ts`, `extensions/pixip-inbox/README.md`, `README.md` (inbox and HTML reports), `ARCHITECTURE.md` (inbox HTML reports, wire protocol), `test/inbox.test.ts`, `test/inboxReport.test.ts`, `test/inboxModel.test.js`, and `ui_work/UI_WIDGET_BREAKDOWN.html`.

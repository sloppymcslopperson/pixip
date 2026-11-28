# Dev tooling

Pixip is developed by using pixip. That dogfooding loop is why its development tooling is part of the product story rather than an appendix about scripts: a CSS edit, a hub change and a test run all happen while a session is live and must not cost that session. This area inventories the reload paths, the watch loop, the test and browser-check harness, the static gates and the documents that act as contracts. It separates what a user can see and keep from the Node-specific mechanics a rewrite may replace.

## Contents

- [Developer stories](#developer-stories)
- [Three ways to pick up a change](#three-ways-to-pick-up-a-change)
- [Hot reload in place](#hot-reload-in-place)
- [Watch mode](#watch-mode)
- [Dev mode and serious mode](#dev-mode-and-serious-mode)
- [The test harness](#the-test-harness)
- [Static gates](#static-gates)
- [Browser checks](#browser-checks)
- [The full check and the inner loop](#the-full-check-and-the-inner-loop)
- [Docs as contracts](#docs-as-contracts)
- [Known gaps](#known-gaps)
- [Wireframes](#wireframes)
- [Port-relevant technical notes](#port-relevant-technical-notes)
- [Boundaries](#boundaries)
- [Sources](#sources)

## Developer stories

- As a developer, I want a CSS or client-JS edit to reach my browser without restarting the daemon or disturbing a live turn.
- As a developer, I want a hub change to take effect in place when it is safe, and a restart that keeps my live sessions when it is not.
- As a developer, I want a watch loop for edit-save-observe, off by default so tests never start one.
- As a reviewer, I want one command that proves types, lint, formatting, tests, workspaces and the main browser flows.
- As a rewrite engineer, I want to know which guarantees are product-critical and which are Node scaffolding.

## Three ways to pick up a change

Three operations share one gate but differ in what they replace.

**Soft refresh** re-reads assets, command policy and the session index without touching a child or a socket, so any turn keeps running. It is `pixip refresh`, `SIGHUP`, `POST /api/refresh` and the header's `reload` control; `/health` exposes `startedAt`, a `reloads` counter and the current `generation`, so a caller can verify it without guessing.

**`/reload`** is the daemon-wide in-place step. It refuses while any live session is not `idle`/`stopped`, has a pending UI request, is running bash or has an unsettled turn; it never forces. When the gate is clear it imports the next daemon code generation, commits only after a successful import, then re-reads assets and policy and reloads every live child. The listener, open sockets and live children stay up; a connected page is refreshed for the new asset nonce. It is user-only (`pixip reload` from inside a session exits 2).

**`/pixup-restart`** replaces the daemon process through the detached restart helper. It refuses while a session is busy and paints an inline card naming the blockers; Force interrupts those turns. It persists the live logical session ids, the old daemon announces `{"t":"restarting"}`, and the browser reconnects with its durable cursor. The new daemon reattaches the persisted live set from JSONL, so dashboard grouping does not visibly change and nothing is lost that the JSONL does not already hold. The card offers an opt-in pause/resume round before a forced restart.

`pixip restart --when-idle` is the matching CLI path: it waits for other sessions to settle, and the stop/start runs in a detached helper so it survives the shutdown of the Pi child that invoked it. `pixip stop` from inside a session refuses instead of silently becoming a restart.

Assets and policy are always soft, hub code is in-place when idle, and entry flags, serve options or environment changes need the process replaced. `requiresRestart` says when the last case applies rather than claiming a swap covered it.

<div align="center">
<svg viewBox="0 0 780 340" width="100%" style="display:block;width:100%;max-width:780px;height:auto" role="img" aria-label="Reload decision tree: an asset, policy or index change uses soft refresh; daemon code uses an in-place reload after the safety gate; entry, flag or environment changes need a process restart; a busy session blocks reload and offers pause or force">
  <rect x="4" y="4" width="772" height="332" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">WHAT CHANGED? · WHAT MUST BE REPLACED?</text>

  <rect x="300" y="42" width="180" height="38" rx="7" fill="#241f33" stroke="#322b45"/>
  <text x="316" y="65" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">edit saved / command run</text>
  <line x1="390" y1="80" x2="390" y2="100" stroke="#6f6889"/>
  <polygon points="390,100 540,132 390,164 240,132" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="344" y="135" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">what changed?</text>

  <line x1="240" y1="132" x2="196" y2="132" stroke="#6f6889"/>
  <rect x="20" y="104" width="176" height="56" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="30" y="123" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">assets / policy / index</text>
  <text x="30" y="138" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">soft refresh · children untouched</text>
  <text x="30" y="150" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">pixip refresh · SIGHUP · header</text>

  <line x1="390" y1="164" x2="390" y2="184" stroke="#6f6889"/>
  <rect x="268" y="184" width="244" height="50" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="278" y="203" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">hub / server code</text>
  <text x="278" y="218" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">/reload: import generation, then commit</text>

  <line x1="390" y1="234" x2="390" y2="252" stroke="#6f6889"/>
  <polygon points="390,252 512,276 390,300 268,276" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="344" y="279" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">gate clear?</text>

  <line x1="512" y1="276" x2="548" y2="276" stroke="#6f6889"/>
  <rect x="548" y="246" width="212" height="58" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="558" y="265" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">no: refusal card</text>
  <text x="558" y="280" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">name blockers · pause opt-in</text>
  <text x="558" y="292" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">wait / cancel / force restart</text>

  <line x1="268" y1="276" x2="232" y2="276" stroke="#6f6889"/>
  <rect x="20" y="246" width="212" height="58" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="30" y="265" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">yes: commit generation</text>
  <text x="30" y="280" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">assets + policy + every child</text>
  <text x="30" y="292" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">page refresh · nonce rotates</text>

  <rect x="548" y="184" width="212" height="50" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="558" y="203" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">entry / flags / env</text>
  <text x="558" y="218" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">requiresRestart → /pixup-restart</text>
  <line x1="512" y1="132" x2="548" y2="200" stroke="#322b45" stroke-dasharray="3 3"/>
</svg>
</div>

## Hot reload in place

A successful `/reload` imports the next generation first and fails closed: an import error leaves the old graph serving with `status: "error"` and no partial swap. On success it applies the new hub prototype to the existing hub object and replaces the server's implementation record, so the listener, every socket and every child stay open. Then it re-reads assets and policy/index through the soft-refresh path, rotates the browser nonce, and asks each host child to reload; system-pi children are respawned through the current host configuration. Child failures are reported per session and do not roll the code back.

The served `index.html` carries a per-daemon nonce in a meta tag; both `/reload` and `/pixup-restart` send it back, and a stale page is refused rather than acted on. A successful reload broadcasts an ephemeral `notice` frame (never JSONL), paints a local transcript row and forces one page reload so every client picks up the new assets and nonce. The row is remembered once in `sessionStorage` so it survives that reload.

A refusal is a local card, not a broken page. It names every blocker and offers `Pause and resume sessions`. Checking it re-sends with `pause: true`: the daemon steers each blocker with a pause prompt, waits up to 30 s for the gate to clear, reloads, and resumes sessions still live and `idle`/`stopped` with `Reload is finished, please resume.`. A timeout offers `Wait longer` or a cancel that keeps or removes the pause requests.

## Watch mode

`--watch` is the development loop and is off by default on both `run` and `daemon`. It watches `src/` and `extensions/` recursively, ignores `node_modules`, `.git`, `fit/` and `tmp/`, and debounces a burst of writes for 200 ms. It holds one reload in flight and coalesces edits that arrive during it into one pending rerun. The injected watcher factory keeps tests from leaving a real file watcher behind.

It reads the same safety gate. A busy session is never interrupted: the loop logs the deferral once, polls roughly once a second and, after 60 s, broadcasts an ephemeral `watchDeferred` notice that paints a local card. `Keep waiting` dismisses it until the next prompt; `I'll reissue later` sends `watch_cancel` and drops the pending reload. A successful reload broadcasts the normal notice, so the card disappears with the page refresh. A failed reload, including a half-written TypeScript save, is logged and shown while the daemon keeps serving; the next file change retries. The CLI owns the watcher and closes it on shutdown.

## Dev mode and serious mode

The daemon defaults to dev mode, re-reading client assets per request, which is what makes a CSS or client-JS edit appear on the next page load without a process change. `--serious-mode` serves the startup asset snapshot instead and disables the dev panel fixture, the posture for hosting pixip as a stable service. Either mode still needs `/reload` for hub code and a restart for entry flags. This is a serving switch, not a build step: no bundler, no artifact, no framework.

## The test harness

Every test is isolated by `--data-dir`. Pi is spawned with `--session-dir <data-dir>/sessions`, so nothing in `~/.pi/agent/sessions` is read or written. Parallel instances on another `--port`/`--data-dir` cannot collide, and two processes never attach to one live session file. `test/helpers/harness.ts` owns temporary roots, the fake Pi path and cleanup; `test/fixtures/fake-pi.mjs` and `fake-pi-host.mjs` stand in for the real child, so the protocol suite exercises framing and the hub without a model. `test/setup.ts` strips ambient `PIXIP_*` pointers so a test spawned from inside a pixip session still uses the fixture.

`npm test` runs every `test/*.test.js` and `test/*.test.ts` file through `tools/test-run.mjs`, using `availableParallelism()` for file concurrency. `npm run test:fast` runs the same set minus the four process-heavy suites (`daemon`, `backend`, `reload`, `worktree-cli`); `test:full` is the full set. The split is about wall time, not weaker assertions: anything spawning a real daemon or a cold child is postponed to the full run. The suites cover what a rewrite could accidentally duplicate — protocol framing, RPC and ANSI rendering, reload generations, client import boundaries, render and transcript scale, refs, inbox and worktrees.

## Static gates

`npm run check:static` runs four independent gates concurrently and prints each child's buffered output as one attributed section, so two failures stay legible in one run:

- `check:imports` parses the client with the TypeScript compiler API and rejects import cycles, anything importing `app.js`, cross-cluster feature imports, and feature imports outside `app.js`/`frames.js`. Its cluster map is the only source of truth for the dashboard/session/composer boundaries.
- `format:check` runs Prettier over code and markup only (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.json`, `.css`, `.html`). Markdown is deliberately not in this gate.
- `typecheck` runs `tsc --noEmit` with an incremental build-info cache.
- `lint` runs ESLint with a cache.

`format:docs` is the on-demand Markdown check. Prose is not format-gated, so a trailing space or table-padding change cannot fail `npm run check`; the docs command exists for people who want it.

`check:workspaces` covers the npm workspaces from the root without paying full tool startup per workspace: concurrent typechecks, lint with two workers on a two-CPU box, then each workspace's tests. Root formatting is not repeated because root `format:check` covers the whole tree. `check:timings` re-runs the full pipeline serially and ranks each test file, with soft budgets (55 s static, 70 s full test, 40 s browser, 60 s workspaces) that warn rather than fail.

## Browser checks

`tools/browser-check.mjs` boots an in-process fixture Hub and server on an ephemeral port with the real `src/client` assets and the fake Pi fixture. It drives the dashboard, composer submit, inline `select`, A2UI fixture panel and transcript windows at 390x844 and 1280x900. Any page error, console error or horizontal overflow fails the run. It is part of `npm run check`; without `PIXIP_CHROME` it prints a skip and exits 0, so a box without Chromium stays green. That skip is not browser evidence — a layout ticket still needs a real browser pass.

`tools/shot.mjs` loads a running daemon at a given viewport, prints the box model of the header, list, log and composer, flags overflow and console/page errors, and writes a screenshot. It is how a resize is asserted rather than eyeballed. The responsive contract lives in the client: one asset set, CSS media/container queries only, no user-agent branching and no duplicated markup per breakpoint.

## The full check and the inner loop

`npm run check` is the gate a ticket closes on: `check:static`, the full test suite, the scripted browser checks and the workspace checks. `npm run check:fast` is the inner loop: the four static gates plus `test:fast`. A queue never ends on `test:fast`; the last ticket runs the full suite.

Static gates are cheap and catch most mistakes before any process starts; the full suite is the broad behavioural net; the browser pass covers flows only a DOM can break; the workspace pass covers the packages that ship beside the root. Timing is a soft report, so a slow machine cannot fail a correct change.

## Docs as contracts

Four documents carry rules that code and tests are expected to match.

`ARCHITECTURE.md` owns invariants, the wire protocol, the reload and restart transaction, the memory policy and the measured latency table. If a change moves a number there, it is updated in the same change. It also names the Rust-port boundary, so it is a design contract rather than a tour.

`docs/TUI-parity.md` is the command-by-command coverage map: done, a `NN-ticket` that owns the gap, or TUI-only because there is no RPC surface. "Can I stop using the terminal yet" has one answer.

`docs/reftags.md` fixes the user-facing ref grammar and points at the one implementation; the regexes live in `src/client/reftags.js` and nowhere else.

`ui_work/UI_WIDGET_BREAKDOWN.html` is the visual and structural inventory: screens and widgets, the palette token contract, stylesheet load order, state classes, the responsive contract and a retheme checklist. A styling pass must not quietly change the widget set.

## Known gaps

These are gaps, not features:

- theme tokens are not ported: the TUI uses `okhsl`, which browsers do not support without conversion;
- input history and `@file` completion are absent from the composer;
- the transcript is not virtualised, so very long sessions are bounded by the client's rendering strategy rather than a windowing layer;
- there is no authentication of any kind; binding is loopback by default and a non-loopback bind is an explicit, warned opt-in;
- a browser check silently skips without `PIXIP_CHROME`, so a green `check` on such a box proves nothing about the DOM.

## Wireframes

The diagram above is the reload decision tree; below are the check pipeline and the developer inner loop.

<div align="center">
<svg viewBox="0 0 800 260" width="100%" style="display:block;width:100%;max-width:800px;height:auto" role="img" aria-label="Test gate pipeline: fast loop runs static gates and fast tests; ticket close adds the full test suite, browser checks and workspace checks">
  <rect x="4" y="4" width="792" height="252" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">CHECK PIPELINE · THE INNER LOOP STOPS EARLY</text>

  <rect x="24" y="44" width="170" height="76" rx="8" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="36" y="64" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">check:static</text>
  <text x="36" y="80" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">imports · format · tsc · lint</text>
  <text x="36" y="93" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">four children, one section each</text>
  <text x="36" y="108" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">fast + full</text>

  <line x1="194" y1="82" x2="226" y2="82" stroke="#6f6889"/>
  <rect x="226" y="44" width="170" height="76" rx="8" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="238" y="64" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">test:fast</text>
  <text x="238" y="80" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">every suite except daemon,</text>
  <text x="238" y="93" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">backend, reload, worktree-cli</text>
  <text x="238" y="108" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">fast only</text>

  <line x1="396" y1="82" x2="428" y2="82" stroke="#6f6889"/>
  <rect x="428" y="44" width="170" height="76" rx="8" fill="#1d1a29" stroke="#e0af68"/>
  <text x="440" y="64" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">full test suite</text>
  <text x="440" y="80" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">adds the four process-heavy</text>
  <text x="440" y="93" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">suites; closes a ticket</text>
  <text x="440" y="108" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">full only</text>

  <line x1="598" y1="82" x2="630" y2="82" stroke="#6f6889"/>
  <rect x="630" y="44" width="150" height="76" rx="8" fill="#1d1a29" stroke="#e0af68"/>
  <text x="642" y="64" font-family="ui-monospace, monospace" font-size="9" fill="#e0af68">browser + workspaces</text>
  <text x="642" y="80" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">390/1280 flows, overflow</text>
  <text x="642" y="93" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">and all workspace suites</text>
  <text x="642" y="108" font-family="ui-monospace, monospace" font-size="7" fill="#9ece6a">full only</text>

  <line x1="24" y1="150" x2="776" y2="150" stroke="#322b45" stroke-dasharray="4 4"/>
  <text x="36" y="174" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">check:fast = static + test:fast</text>
  <text x="36" y="192" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">use while working a ticket; it is not a close gate.</text>
  <text x="36" y="214" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">check = static + full tests + browser + workspaces</text>
  <text x="36" y="232" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">a ticket closes here, and a queue ends on the full suite.</text>
</svg>
</div>

<div align="center">
<svg viewBox="0 0 800 280" width="100%" style="display:block;width:100%;max-width:800px;height:auto" role="img" aria-label="Developer inner loop: edit, save, watch reload, observe; a busy session defers; a hub change uses in-place reload when idle or a restart that keeps sessions">
  <rect x="4" y="4" width="792" height="272" rx="14" fill="#16141f" stroke="#322b45"/>
  <text x="18" y="24" font-family="ui-monospace, monospace" font-size="10" fill="#6f6889">THE DOGFOODING LOOP · EDIT WITHOUT LOSING THE TURN</text>

  <rect x="24" y="46" width="150" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="36" y="66" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">edit src/ or CSS</text>
  <text x="36" y="82" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">the daemon is running</text>

  <line x1="174" y1="72" x2="206" y2="72" stroke="#6f6889"/>
  <rect x="206" y="46" width="150" height="52" rx="7" fill="#1d1a29" stroke="#322b45"/>
  <text x="218" y="66" font-family="ui-monospace, monospace" font-size="9" fill="#e7e3f2">save</text>
  <text x="218" y="82" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">200 ms debounce</text>

  <line x1="356" y1="72" x2="388" y2="72" stroke="#6f6889"/>
  <polygon points="456,46 530,72 456,98 382,72" fill="#1d1a29" stroke="#bb9af7"/>
  <text x="424" y="70" font-family="ui-monospace, monospace" font-size="8" fill="#e7e3f2">busy?</text>

  <line x1="530" y1="72" x2="562" y2="72" stroke="#6f6889"/>
  <rect x="562" y="46" width="214" height="52" rx="7" fill="#1d1a29" stroke="#e0af68"/>
  <text x="574" y="66" font-family="ui-monospace, monospace" font-size="8" fill="#e0af68">no: reload now</text>
  <text x="574" y="82" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">page refreshes, children reload</text>

  <line x1="456" y1="98" x2="456" y2="120" stroke="#6f6889"/>
  <text x="462" y="114" font-family="ui-monospace, monospace" font-size="7" fill="#f7768e">yes</text>
  <rect x="330" y="120" width="252" height="54" rx="7" fill="#1d1a29" stroke="#f7768e"/>
  <text x="342" y="139" font-family="ui-monospace, monospace" font-size="8" fill="#f7768e">defer · poll the gate once a second</text>
  <text x="342" y="154" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">after 60 s: card · keep waiting / reissue later</text>
  <text x="342" y="166" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">the turn is never interrupted</text>

  <line x1="456" y1="174" x2="456" y2="196" stroke="#6f6889"/>
  <rect x="300" y="196" width="312" height="54" rx="7" fill="#1d1a29" stroke="#9ece6a"/>
  <text x="312" y="215" font-family="ui-monospace, monospace" font-size="8" fill="#9ece6a">idle: reload in place</text>
  <text x="312" y="230" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">or /pixup-restart keeps the live set from JSONL</text>
  <text x="312" y="242" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">no transcript bytes are lost</text>

  <text x="36" y="226" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">client assets: dev mode re-reads per request ·</text>
  <text x="36" y="240" font-family="ui-monospace, monospace" font-size="7" fill="#6f6889">serious mode serves the startup snapshot</text>
</svg>
</div>

## Port-relevant technical notes

Port notes only; the user-visible guarantees above are the contract.

### What reload depends on

`bin/pixip.ts` registers `src/reload/register.ts` as a Node module resolve hook and imports `src/hub.ts?gen=N` and `src/server.ts?gen=N`. The hook propagates `gen` from the parent URL to every project `src/` specifier, so one generation is a fresh hub/server/hubControl graph while `bin/` and `node_modules/` stay shared. `src/reload/manager.ts` keeps the serving generation and a separate attempt counter; a failed import must burn its attempt number because Node caches a rejected dynamic import by URL. The commit point is `Object.setPrototypeOf(existingHub, NewHub.prototype)` plus a replacement `state.impl = {handleHttp, handleSocket, refresh, reload}`. Socket callbacks and HTTP requests read `state.impl` at call time, so new hub methods apply to an already-open socket; wiring created once per connection needs a reconnect for a changed frame shape.

None of that is a protocol requirement. A Rust port may implement the contract as a supervised restart: the page reloads for new assets, live children reload or are respawned, and JSONL plus the durable cursor mean no conversation is lost. Worth keeping are the gate's blocker list, the fail-closed preflight, the per-daemon nonce, `requiresRestart` honesty, and the ephemeral notice that survives one forced page load. Generation-tagged imports, `module.register`, the pause file, the injectable watcher and the debounce timers are Node scaffolding a port can replace, provided a busy session still defers rather than interrupts and a failed reload leaves the daemon serving.

Pause/resume is advisory steering, not a handshake. `src/reload/pause.ts` persists `{id, logicalId, name, state}` to `<data-dir>/pixip.pause.json` before a forced restart, waits up to 30 s, and resumes only targets still live with the same logical id and `idle`/`stopped`. A port must not claim acknowledgement it did not receive.

### Test and build boundaries

`--data-dir` is the isolation contract: it owns the pid/state/log files, `sessions/`, `inbox.json`, archive/trash and uploads, and sets Pi's `--session-dir`. Tests must never point at the real session directory and never attach two processes to one live JSONL.

The client is served as-is: no bundler, no build step, no framework, so `src/client` is the artifact and the browser check imports the real assets. `tools/check-client-imports.mjs` enforces the module graph with the TypeScript compiler API instead of a new dependency, and its cluster map is the only copy. `check-parallel`, `check-workspaces` and `test-run` keep the gate fast without changing what it asserts; `test-run` defines the fast/full split by suite name.

### Docs that must not drift

`ARCHITECTURE.md` owns the latency table and reload/restart semantics; `docs/TUI-parity.md` owns each command's status; `docs/reftags.md` owns the grammar and points at `src/client/reftags.js` as the only implementation; `ui_work/UI_WIDGET_BREAKDOWN.html` owns the widget inventory, palette and stylesheet order. A rewrite that changes a number or flow updates the document in the same change. Those files are contracts, not summaries.

## Boundaries

This area owns reload and restart mechanics, watch mode, dev/serious serving, test isolation, static and browser gates, and the four contract documents. Daemon and CLI lifecycle are in `85-daemon-cli`; session control and the restart decision as a user feature in `80-session-control`; the host protocol in `90-host-protocol`; the transcript, composer and dashboard own what a browser check exercises. No port verdicts here.

## Sources

`src/reload.ts`, `src/reload/manager.ts`, `src/reload/register.ts`, `src/reload/watch.ts`, `src/reload/pause.ts`, `src/server.ts` (reload transaction and nonce), `src/hub.ts`, `src/hubControl.ts`, `bin/pixip.ts`, `src/client/reload.js`, `src/client/restart.js`, `src/client/watch.js`, `package.json`, `tools/test-run.mjs`, `tools/check-parallel.mjs`, `tools/check-client-imports.mjs`, `tools/check-workspaces.mjs`, `tools/check-timings.mjs`, `tools/browser-check.mjs`, `tools/shot.mjs`, `test/setup.ts`, `test/helpers/harness.ts`, `test/fixtures/fake-pi.mjs`, `test/fixtures/fake-pi-host.mjs`, `ARCHITECTURE.md` (Reload and restart, Measured latency), `README.md` (Running as a daemon, Checking the layout, Not yet), `docs/TUI-parity.md`, `docs/reftags.md`, `ui_work/UI_WIDGET_BREAKDOWN.html`, and the closed `hotreload` and `test-time` tickets.

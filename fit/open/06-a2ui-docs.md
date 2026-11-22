---
project: pixip
---

Document the inline panel surface, the A2UI renderer, and the custom host panel transport once the renderer and questionnaire are working, and update the TUI-parity map so the replacement of the questionnaire path is discoverable. Keep the protocol and latency sources of truth in `ARCHITECTURE.md` and the user-facing install notes in `README.md`.

### Work

- Add a short “inline panel surface” section to `ARCHITECTURE.md`: the dedicated slot between transcript and composer, collapsed/expanded states, why it is not a modal and not in the append-only transcript, pending-UI replay, and where the panel host boundary sits.
- Add an “A2UI panels” section: the `pixip-pi-host` `panel` request/response, opaque payload, A2UI v1.0 message order, action JSON, lazy bundle boundary, read-only/history posture, and why the hub never parses A2UI.
- Add the renderer bundle’s license/version provenance beside the asset (Apache-2.0, `@a2ui/web_core`/`@a2ui/lit` version) and a dev-only rebuild note; CI must not need a bundler.
- Update `docs/TUI-parity.md` / README where the questionnaire is described, including the host fallback order (A2UI inline panel → TUI custom → dialogs) and how to uninstall `pi_questionare`.
- Document the host boundary: `pixip-pi-host` embeds project-local Pi, shares the user's agent dir for now, and is not yet the default backend.
- State the security boundary: A2UI is data, catalogs are fixed, no raw HTML/JS, URLs sanitized.
- State that completed A2UI surfaces are not currently persisted into session history; a pending panel is replayed from the hub's blocking-UI cache only.

### Acceptance

- A new contributor can see where an A2UI payload enters the client, how an action leaves it, how the inline surface collapses/expands, and that the host (not upstream Pi) provides `panel`.
- `npm run check` stays green; no screenshot is required unless layout changes.
- The docs do not claim the old plugin is removed before the new one is verified, and do not claim historical A2UI exists.

---
area: refs
part: inventory
project: feature-inventory
---

Capture the reference system end-to-end: how an agent writes `[pixip-ref=…]`, how it becomes a chip, how a user resolves, copies or navigates it, and how the CLI resolves it. This is a cross-cutting area spanning transcript, composer, client, hub and CLI.

### Goal
An inventory reader should understand the reference lifecycle from agent output to human navigation, and why the grammar lives in exactly one place.

### Scope
- Ref grammar and kinds, including what a ref can point at (session, entry, file, and any other supported kind).
- Resolution: `pixip ref` CLI and server-side resolution through `sessions.json` plus the JSONL.
- Transcript chips: rendering, tap behaviour, jump, copy, and fallback when a ref cannot be resolved.
- Composer ref chips: insertion, default insert mode, removal, and interaction with plain text.
- Chip navigation between refs and back to the originating message.
- Reftag actions and any copy affordance.
- Docs: `docs/reftags.md` as the user-facing contract.

### User stories to cover
- As a user, I want a reference in an agent message to become a tappable chip that takes me to the target.
- As a user, I want to copy a reference and paste it back into a prompt or another session.
- As a user, I want an unresolved ref to degrade to readable text rather than a dead control.
- As a user, I want to insert a ref into the composer without hand-typing the grammar.
- As an operator, I want the CLI to resolve a ref the same way the UI does.

### Wireframes (SVG, no screenshots)
- Series of screens: transcript chip, tapped/jump state, composer chip, copy affordance, unresolved fallback.
- Decision-flow diagram: agent emits ref -> parse -> resolve -> chip -> jump/copy; failure -> plain text.

### Technical notes (port-relevant only)
- The single-grammar rule and where it lives; the client/server split and why resolution needs the JSONL.
- Ref kinds and their target addressing scheme, since a rewrite must preserve or deliberately change them.
- Limits: what happens when a target is missing, archived or in another repo.

### Sources to read
`src/reftags.ts`, `src/refResolve.ts`, `src/client/reftag*.js`, `docs/reftags.md`, `README.md` refs, closed `chipwitch/*` tickets for intent, ref tests.

### Acceptance
- Every supported ref kind is listed with an example.
- Parse, resolve, render, tap, copy, insert and failure paths are covered.
- CLI and UI are described as one contract.
- SVG wireframes show the flow, not screenshots.
- Section is 1,500-2,500 words, summary plus TOC.
- `npm run check` is green.

### Constraints
User-centric language first. Port-relevant technical notes only, separate subsection. No port verdicts. No screenshots.

### Output

Write this area to `docs/feature-inventory/75-refs.md`. Do not create or edit `index.md`; `99-compile-report` owns it. The file must stand alone with a 3-5 line summary, its own TOC, user stories, inline SVG wireframes, and a separate port-relevant technical-notes part.

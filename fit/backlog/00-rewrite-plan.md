Replace the prototype with a story-driven codebase in a fresh repo: evidence, stories, features, ADRs, then architecture, a walking skeleton, and cutover, with the old app frozen but runnable as the dogfood tool. Planning artifacts live in `docs/plan/PLAN.md`, `docs/product/`, `docs/features/`, and `docs/adr/`; this ticket is the program umbrella, not an implementation unit.

### Gates

1. Brief + evidence: owner fills the symptom list and jobs.
2. Stories: one file per journey, observable acceptance, no solution words.
3. Feature map: coverage matrix, orphan features cut, ADR questions assigned.
4. ADRs 0003-0012 accepted, each with "what this forbids".
5. Architecture: newcomer locates any behavior in <=2 hops.
6. Walking skeleton: top 3 stories end to end in the new repo.
7. Cutover: new app is the daily driver, old board archived.

Gate tickets are created when each phase starts; do not pre-create them.

### Fixed decisions

- Fresh repo, no compatibility floor (C3/C4).
- Security and sandboxing are host-owned (ADR-0001).
- One shell, rearranged by CSS (ADR-0002).
- Runtime deferred to ADR-0010.

### Rules

- No code before its story has acceptance criteria.
- The current module map is evidence, never a template.
- Existing backlog tickets are re-triaged into stories and closed as superseded; they are not migrated.

### Verification

Each gate passes only when its artifact exists and the exit criterion in `PLAN.md` is met. Phase 1 needs owner input; phases 2-5 get review at each gate.

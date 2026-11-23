---
project: pixip
---

Explore an update-friendly Pi fork or patch set that can hot-swap session records without restarting the process. The spike must keep upstream Pi updates tractable and must not become a pixip-only shim or private extension API.

### Why

A warm child pool helps only when the child already exists. Hot-swapping loaded session records inside one long-lived Pi process could make switching and creation cheap even on a loaded 1 vCPU box. This is separate from reconnect-ticket work, which deliberately avoids a pool.

### Questions

- Which Pi layer owns session replacement (`AgentSession`/`SessionManager`), and can a new JSONL be loaded without tearing down the agent runtime and extensions?
- Can the patch be a small, isolated diff against upstream, or does it require vendoring enough of the runtime that upgrades become merges?
- What is the measured cost of `switch_session` on an 11 MB JSONL, including extension hooks and context rebuild?
- How are in-flight turns, pending extension UI, queued steering, and loaded images handled across a swap?
- What is the memory and failure model for one process serving two logical sessions?
- What is the upgrade story: pinned commit + patch series, vendored workspace package, or upstreamable API?

### Constraints

- Do not add a shim, private extension API, or plugin-side change to pixip.
- Existing Pi extensions must keep working untouched in the normal spawned-child path.
- Any proposal must state how a new Pi release is adopted without replaying a large fork.
- No implementation in this repo until the spike answers the update and correctness questions.

### Done when

A written design compares the options, records measured hot-swap costs, names the exact upstream seams, and either recommends a patch series with an upgrade procedure or rejects the fork in favour of the current spawn model.

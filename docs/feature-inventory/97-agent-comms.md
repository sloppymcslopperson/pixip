# 97 · Agent discovery and messaging

pixip sessions can find and message each other without a human relaying text
through the dashboard. An agent lists the other sessions on the box, picks one
by name, id or id prefix, and sends it a normal prompt; the target's transcript
shows the message as an inbound agent bubble with a link back to the sender.
Discovery is read-only, sending returns an acknowledgement immediately, and no
receipt turn is spent.

## Contents

- [What it is for](#what-it-is-for)
- [Finding other agents](#finding-other-agents): rows, filters, archived and trash
- [Sending a message](#sending-a-message): targeting, wake, steer, acknowledgement
- [What the target sees](#what-the-target-sees)
- [Three equivalent surfaces](#three-equivalent-surfaces): CLI, extension, REST
- [Limits and edge cases](#limits-and-edge-cases)
- [Wireframes](#wireframes)
- [Technical notes (port-relevant)](#technical-notes-port-relevant)

## What it is for

Long-running work is increasingly spread across several sessions: one per
worktree, one per ticket, one per review. Before this feature the only way to
move work between them was for the user to copy a message from one transcript
into another, or to keep one supervising session that did all the dispatching.
Agent messaging makes that a first-class action for the agent itself.

Two questions drive the design. First, can an agent find the right peer without
already knowing its id? Yes: the list is rich enough to recognise a session by
name, state, working directory, repository and branch. Second, can a send be
safe and cheap? Yes: it is a normal prompt with a sender marker, delivered once,
acknowledged immediately, and never held open waiting for the target to finish.

This is coordination tooling, not a chat product. There is no new transcript
type, no server-side conversation state, and no delivery queue that the target
must drain. The message lands in the target exactly where a human prompt would.

## Finding other agents

`pixip agents list` and the `agent_list` tool return one row per session:

- the current Pi id (the stable logical id is in the JSON envelope), the name
  and the state;
- `cwd`, repository, branch and worktree;
- `awaitingUser`, `lastActivity`, and whether this row is the caller (`isSelf`);
- an absolute dashboard URL of the form `http://<host>/#s=<id>`.

Rows cover live, attached and stopped sessions by default. Archived and trash
sessions are hidden unless the caller asks for them (`--all` or
`{all: true}`), and then carry a `stored` field of `archive` or `trash`. Stored
rows are messageable only by explicit id; a name or prefix is not enough to
reach a session the user has put away.

Filters narrow the same list: `--state <state>`, `--cwd <path>`, `--repo <path>`
and `--query <text>` (a case-insensitive substring over name, id, logical id,
cwd, repository and branch). Exact path matching means a filter never quietly
returns a sibling worktree. The caller is marked and sorted first, then rows
group by repository and worktree, newest activity, name and id, so a supervisor
reads "me, then my peers" in a predictable order.

Discovery never creates, wakes, stops, archives or deletes anything. Listing a
stopped session does not start its process, and listing an archived session does
not restore it.

## Sending a message

A send takes a target and one message:

```text
pixip agents send <target> <message> [--json]
agent_send({ target: "auth-fix", message: "Please review the login change." })
```

The target is resolved against the same list: an exact current Pi id or logical
id wins, then a unique active name or id prefix. An ambiguous name or prefix
fails with the candidates rather than guessing. Active sessions are reachable by
any of those forms; archived and trash sessions need an explicit id.

Delivery follows the target's state:

- **idle** — the message is a normal prompt and the turn starts.
- **busy** — the message is a steer into the running turn, the same path a
  human uses when they send while the agent is streaming.
- **stopped** — the session is attached first, then prompted, so a parked
  session wakes without a separate action.
- **archived / trash** — the session is restored, attached and prompted, which
  is the one case where a send has a visible side effect on the dashboard.

The sender is the calling session's `PIXIP_SESSION_ID`, or `local-shell` outside
a session. A session cannot message itself; that returns a 400 instead of a
confusing self-steer.

The call returns as soon as the prompt is dispatched, with the delivery id, the
target's id, name and URL, `stateBefore` and `stateAfter`, and the `delivered`,
`woken` and `streaming` flags. It does not wait for the target's turn, and it
does not send an automatic receipt. A sender that wants confirmation reads the
target's `lastDelivery` from the next discovery call, or simply messages again.

## What the target sees

The delivered prompt begins with one marker line:

```text
[pixip-agent=668d8346-…]
Please review the login change.
```

In the transcript this is not a raw marker. The client recognises the prefix,
strips it, and renders the message as an inbound agent bubble whose header is
"Agent <sender> sent a message". The sender id becomes a link to that agent's
session page, so a reply is one tap away. The rest of the message renders as
normal user text: Markdown, links, ref chips and attachments all behave as they
do for a human prompt. If the sender cannot be resolved to a name, the id is
shown rather than a dead control.

The marker grammar lives in exactly one place on the client, so both the bubble
header and any later use of the same marker agree. Outside pixip the marker is
plain text, which is what makes a copied transcript still readable.

## Three equivalent surfaces

The feature is deliberately one contract with three thin faces:

- **CLI** — `pixip agents list` and `pixip agents send`, with the same filters
  and the same target rules. It works from any shell and needs only
  `PIXIP_DAEMON_URL`.
- **Extension** — the opt-in `pixip-agents` package registers `agent_list` and
  `agent_send`, so an agent can coordinate from inside its turn. pixip does not
  auto-register extensions; a session gets the tools only when its extension set
  includes the package.
- **REST** — `GET /api/agents` for discovery and
  `POST /api/agents/:target/messages` for sends, under the same bind and access
  posture as the rest of the dashboard.

All three share the same filtering, ordering and target resolution, so a name
that works in the CLI works in the tool and in a direct request. The extension
adds no private API: it is a thin client of the same routes, and it reports a
missing daemon or a rejected target as an actionable tool error instead of a
crash.

## Limits and edge cases

- A message is a prompt, not a mailbox. If the target is mid-turn the text is a
  steer, so it can change what that agent is doing. Senders should prefer a
  clear instruction over a question that assumes an idle peer.
- The delivery log is bounded and is not a transcript. Each target keeps only
  its latest acknowledgement, for discovery; the message itself lives in the
  target's session file and nowhere else.
- A target that cannot be woken (dead child, restore failure) makes the send
  fail with a 502 and a readable reason; the delivery is not recorded as
  successful.
- Archived and trash targets need an explicit id, and sending to one restores
  it. The dashboard reflects that restore like any other.
- Discovery is per data dir. Two daemons with different `--data-dir` do not see
  each other's sessions, which is what keeps tests and a second instance
  isolated.
- There is no broadcast. Sending to many peers is a loop of ordinary sends, and
  the sender owns any fan-out policy.

## Wireframes

### Discovery to delivery

```svg
<svg viewBox="0 0 760 300" role="img" aria-labelledby="agent-flow-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <title id="agent-flow-title">Agent discovery and send flow</title>
  <rect width="760" height="300" fill="#0f1115"/>
  <g fill="#1b1f27" stroke="#3a4150" stroke-width="1.5">
    <rect x="20" y="110" width="130" height="64" rx="10"/>
    <rect x="215" y="30" width="150" height="64" rx="10"/>
    <rect x="215" y="190" width="150" height="64" rx="10"/>
    <rect x="430" y="110" width="140" height="64" rx="10"/>
    <rect x="620" y="110" width="120" height="64" rx="10"/>
  </g>
  <g fill="#e6e9ef" font-size="14" text-anchor="middle">
    <text x="85" y="138">sender agent</text>
    <text x="85" y="158" fill="#9aa4b2" font-size="12">CLI or tool</text>
    <text x="290" y="58">GET /api/agents</text>
    <text x="290" y="78" fill="#9aa4b2" font-size="12">name, state, cwd, URL</text>
    <text x="290" y="218">POST …/messages</text>
    <text x="290" y="238" fill="#9aa4b2" font-size="12">target + message</text>
    <text x="500" y="138">hub</text>
    <text x="500" y="158" fill="#9aa4b2" font-size="12">resolve, wake, steer</text>
    <text x="680" y="132">target</text>
    <text x="680" y="152" fill="#9aa4b2" font-size="12">prompt + marker</text>
  </g>
  <g stroke="#7c8cff" stroke-width="2" fill="none" marker-end="url(#arrow)">
    <path d="M150 130 L205 70"/>
    <path d="M150 152 L205 210"/>
    <path d="M365 62 L420 120"/>
    <path d="M365 222 L420 164"/>
    <path d="M570 142 L610 142"/>
  </g>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#7c8cff"/>
    </marker>
  </defs>
</svg>
```

### Target state on send

```svg
<svg viewBox="0 0 760 220" role="img" aria-labelledby="agent-state-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <title id="agent-state-title">What a send does to the target</title>
  <rect width="760" height="220" fill="#0f1115"/>
  <g fill="#1b1f27" stroke="#3a4150" stroke-width="1.5">
    <rect x="20" y="80" width="120" height="56" rx="10"/>
    <rect x="205" y="20" width="140" height="56" rx="10"/>
    <rect x="205" y="80" width="140" height="56" rx="10"/>
    <rect x="205" y="140" width="140" height="56" rx="10"/>
    <rect x="420" y="80" width="150" height="56" rx="10"/>
    <rect x="620" y="80" width="120" height="56" rx="10"/>
  </g>
  <g fill="#e6e9ef" font-size="13" text-anchor="middle">
    <text x="80" y="112">target state</text>
    <text x="275" y="52">idle</text>
    <text x="275" y="112">busy</text>
    <text x="275" y="172">stopped / stored</text>
    <text x="495" y="112">deliver prompt</text>
    <text x="680" y="112">turn starts</text>
  </g>
  <g fill="#9aa4b2" font-size="11" text-anchor="middle">
    <text x="205" y="68">prompt</text>
    <text x="205" y="128">steer</text>
    <text x="205" y="188">attach or restore</text>
  </g>
  <g stroke="#7c8cff" stroke-width="2" fill="none" marker-end="url(#arrow2)">
    <path d="M140 100 L195 56"/>
    <path d="M140 108 L195 108"/>
    <path d="M140 116 L195 160"/>
    <path d="M345 108 L410 108"/>
    <path d="M570 108 L610 108"/>
  </g>
  <defs>
    <marker id="arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#7c8cff"/>
    </marker>
  </defs>
</svg>
```

## Technical notes (port-relevant)

**Contract.** Discovery is `GET /api/agents` with `all`, `cwd`, `repo`, `state`,
`query` and `self` parameters, returning `{"agents":[...],"count":N}`. Sending
is `POST /api/agents/:target/messages` with `{message, sender}`, returning the
acknowledgement. Both are ordinary REST on the hub; no new websocket frame is
involved, and the target's transcript only ever sees a normal prompt.

**State ownership.** The hub owns target resolution, wake/restore and delivery.
The session index owns names, ids and stored state. The delivery log is hub
state, bounded (newest 200), persisted as `<data-dir>/agent-deliveries.json`,
and only read to decorate discovery rows with `lastDelivery`. The message body is never copied
into that log; the target's JSONL remains the only transcript.

**Sender identity.** `PIXIP_SESSION_ID` is injected into every Pi child, so the
extension and the CLI agree on who sent a message. The marker line
`[pixip-agent=<sender>]` is the only wire-visible trace, and its grammar is
client-owned in one module so a rewrite can change the presentation without
touching the hub.

**Ordering of effects.** A send resolves the target, optionally restores and
attaches, then prompts. Only after the prompt succeeds is the receipt written.
A failed wake or prompt returns 502 and records nothing, so `lastDelivery` never
claims a delivery that did not happen. A busy target is steered through the same
`streamingBehavior` path as the composer, not a separate mechanism.

**Port pressure.** The discovery schema is the part a rewrite is most likely to
reshape: the fields are deliberately plain (`id`, `logicalId`, `state`, `cwd`,
`repo`, `branch`, `awaitingUser`, `lastActivity`, `isSelf`, `url`) so another
hub can produce them without pixip internals. The rest — a sender marker on a
prompt, a bounded receipt log, and a bubble in the transcript — is replaceable
presentation and policy, not a protocol dependency.

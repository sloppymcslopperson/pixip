# pixip-agents

An opt-in Pi extension that registers `agent_list` and `agent_send`, so an
agent can discover and message other pixip sessions without opening the web UI.

```ts
agent_list();
agent_list({ state: "idle" });
agent_list({ repo: "/work/pixip", query: "auth" });
agent_list({ all: true });
agent_send({ target: "auth", message: "Please review the login fix." });
```

Each returned agent has the current Pi session id, the stable logical id, name,
state, cwd, repo, branch/worktree, `awaitingUser`, `lastActivity`, `isSelf` and
an absolute URL of the form `http://host:port/#s=<id>`. The calling session
(`PIXIP_SESSION_ID`) is marked `isSelf` and listed first.

- Active sessions are live, attached and stopped. Archived and trash sessions
  are hidden unless `all: true`; those rows carry `stored: "archive"` or
  `stored: "trash"`.
- `cwd` and `repo` match an exact resolved path. `query` is a case-insensitive
  substring over name, id, logical id, cwd, repo and branch. `state` is one of
  `starting`, `idle`, `busy`, `stopped`, `error`.
- Active rows include the latest delivery acknowledgement as `lastDelivery`:
  delivery id, sender, time, delivered/woken/streaming and states. Stored rows
  do not.

`agent_send({ target, message })` delivers one normal prompt and returns
immediately with `{ deliveryId, target: { id, name, url, stateBefore,
stateAfter }, delivered, woken, streaming, at }`:

- `target` is an exact id/logical id, or a unique active name or id prefix.
  Exact ids win; ambiguous names or prefixes fail with candidates. Archived and
  trash sessions require an explicit id.
- A stopped target is attached, an archived/trash target is restored, and a busy
  target is steered. The target sees `[pixip-agent=<sender>]` on the first line;
  the sender is `PIXIP_SESSION_ID`, or `local-shell` outside a session.
- The tool result includes the target URL so the caller can open the page. It
  never waits for the target's turn and sends no automatic receipt; check
  `agent_list`'s `lastDelivery` later, or send another message.

The tools are thin clients for `${PIXIP_DAEMON_URL}/api/agents`:

- `PIXIP_DAEMON_URL` is required and normally injected by the hub into every Pi
  child. Outside pixip, set it explicitly; the extension never guesses an
  address.
- Discovery is a `GET`; send is a `POST` to
  `/api/agents/<target>/messages` with `{ message, sender }`.
- The discovery envelope is `{"agents":[...],"count":N}`. Tool text lists one
  agent per block with its URL; `details` carries the same envelope. Send text
  includes the acknowledgement and URL; `details` carries the ack.
- A missing daemon, malformed filter or non-2xx response comes back as an
  actionable tool error string, not a crash.

## Install / opt in

```bash
pi install /path/to/pixip/extensions/pixip-agents
# or load it for one run:
pi -e /path/to/pixip/extensions/pixip-agents/src/index.ts
```

pixip does not auto-register extensions: it spawns the real `pi` binary, so the
tool is available only in sessions whose extension set includes this package.

## Develop

```bash
npm run check --workspace pixip-agents
```

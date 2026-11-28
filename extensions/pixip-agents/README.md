# pixip-agents

An opt-in Pi extension that registers `agent_list`, so an agent can discover
other pixip sessions without opening the web UI.

```ts
agent_list();
agent_list({ state: "idle" });
agent_list({ repo: "/work/pixip", query: "auth" });
agent_list({ all: true });
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
- The tool is read-only: it never creates, wakes, stops, archives or deletes a
  session.

The tool is a thin `GET ${PIXIP_DAEMON_URL}/api/agents`:

- `PIXIP_DAEMON_URL` is required and normally injected by the hub into every Pi
  child. Outside pixip, set it explicitly; the extension never guesses an
  address.
- The response envelope is `{"agents":[...],"count":N}`. Tool text lists one
  agent per block with its URL; `details` carries the same envelope.
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

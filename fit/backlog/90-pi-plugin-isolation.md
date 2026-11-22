---
project: pixip
---

Eventually pixip should run its project-local Pi with a plugin/config set that is independent of the user's system Pi, without breaking the current login. This is deliberately deferred because moving the agent directory also moves `auth.json`, `models.json`, trust and model settings, which would break this dogfooding agent until auth is migrated.

### Options to evaluate

- Keep the shared agent dir and pass an explicit extension set (`noExtensions`/`--no-extensions` plus `-e` paths) so only plugins are isolated.
- Use a dedicated `<data-dir>/pi` agent dir for full isolation, with `auth.json`/`models.json` copied or symlinked from the user's Pi directory.
- Use a dedicated dir plus project-local npm-installed extension packages; run `pi install` with `PI_CODING_AGENT_DIR` pointing at it.
- Decide what pixip loads by default: pixip-bundled plugins, user project `.pi/extensions`, user global extensions, or a per-project allowlist.

### Constraints

- Do not change the default agent dir until login, models and project trust are verified end to end.
- The title/label child and the session host must use the same Pi agent dir and plugin set.
- `PIXIP_SESSION_ID`/`PIXIP_INSIDE` and the data-dir session isolation must keep working.
- Document how a user opts back into their normal `~/.pi/agent` setup.

### Acceptance

- A new session can run with an explicit plugin set independent of the system Pi while reusing existing auth/models.
- Login/model refresh still works after migrating to a dedicated agent dir, or the docs explain the required one-time migration.
- Tests cover extension discovery assertions without depending on the developer's `~/.pi/agent` content.
- The default behavior is either unchanged or clearly gated behind a flag.

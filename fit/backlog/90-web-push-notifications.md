---
blocked_on: https-from-phone
grilled: false
leg: dogfooding-test
project: pixip
---

Add a no-cache service worker plus manifest, then Web Push so iOS can ding/notify when pixip is waiting on the user (extension dialog, turn settled, `notify`), including when the phone is locked or Safari is backgrounded. This supersedes the in-page Web Audio ding idea, which only works while pixip is foregrounded and cannot ring a locked phone.

### Why this is backlog

Blocked on a human decision: service workers and Web Push require a secure context, and pixip currently serves plain `http` on the VPN address. The phone cannot register a service worker from `http://100.x.x.x:8137`. Pick one transport before implementation:

- `tailscale serve` / MagicDNS HTTPS in front of `127.0.0.1:8137` (recommended: same private posture, real cert);
- Caddy/nginx TLS with a private CA or a real domain;
- accept localhost-only SW and drop the phone story (not useful).

### Scope when promoted

1. `src/client/sw.js`: **no fetch handler** (no caching, assets still served as-is). Only `push`, `notificationclick` and, if needed, `install`/`activate` cleanup.
2. `src/client/manifest.json` (+ icons) with `display: standalone`, `start_url: "/"`, served as a static asset; `index.html` links it.
3. `src/client/app.js`: register the SW and expose an opt-in "notify me" action. Permission (`Notification.requestPermission`) must run inside a user gesture; no auto-prompt on load.
4. Hub: persist VAPID keys and push subscriptions under `--data-dir`, expose subscribe/unsubscribe frames, and send a push on the "waiting for input" events. Do not hand-roll RFC 8291 encryption; use a maintained `web-push` implementation or document the Rust-port equivalent.
5. Events that count as waiting: `extension_ui_request` select/confirm/input/editor (the blocking approval dialogs) and, if opted in, `agent_settled` when the turn ends. Reuse `notify` where Pi already emits one.
6. Notifications must deep-link back to `#s=<sessionId>` and focus/refresh the page via `notificationclick`.

### iOS constraints to record in the docs

- Web Push requires the app to be **added to the Home Screen** (iOS 16.4+); a normal Safari tab cannot receive push.
- Notification sound is chosen by iOS; there is no custom ding. The ring/silent switch still mutes it.
- iOS may throttle/drop pushes for an uninstalled or long-idle PWA; treat delivery as best-effort.
- HTTPS is required for both SW registration and push; plain VPN `http` is a hard fail.

### Done when

- On an HTTPS origin on the phone, the SW registers, the manifest makes pixip installable to the Home Screen, and an approved opt-in produces a visible notification after an `extension_ui_request` while Safari is backgrounded.
- No caching: after `pixip refresh` / header `reload`, a page reload serves current assets (no stale SW cache).
- Permission is never requested without a user tap; a declined permission leaves the UI unbroken and can be retried from settings.
- VAPID keys and subscriptions survive a hub restart in `--data-dir`; unsubscribing removes the record and stops pushes.
- `npm run check` green; `docs/parity.md` gets a row; `README.md` documents the HTTPS/Home-Screen setup and its limits.

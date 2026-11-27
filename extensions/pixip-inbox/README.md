# pixip-inbox

An opt-in Pi extension that registers `inbox_send`, so an agent can leave a
durable message in the pixip dashboard inbox without shell quoting.

```ts
inbox_send({
	subject: "Review the migration",
	body: "The staging build is green; the logs are at /tmp/deploy.log.",
	purpose: "attention-needed",
});
```

Purposes are `attention-needed`, `deliverable`, `extra-info` and `no-rush`.
The message outlives the session and appears in the dashboard inbox sheet; the
hub attributes it to the calling session through `PIXIP_SESSION_ID`.

## HTML reports

`inbox_report` creates and edits an HTML report attached to an inbox message.
Call it with no arguments for the built-in help. The agent never edits the
report files directly; every write is validated by the hub.

```ts
inbox_report({ action: "new", name: "migration" });
inbox_report({ action: "add_asset", name: "migration", path: "/tmp/chart.png" });
inbox_report({ action: "write", name: "migration", html: "<!doctype html>…" });
inbox_send({
	subject: "Migration report",
	body: "The staging run is green.",
	purpose: "deliverable",
	reportName: "migration",
});
```

- `write` requires `existingHtml` (the exact output of `action:"show"`) when
  overwriting an existing report; the first write omits it.
- `add_asset` copies a local PNG/JPEG/GIF/WebP/SVG/CSS/WOFF/WOFF2/TTF/OTF into
  the report and returns the top-level filename to reference. Images are capped
  at 1 MiB, `index.html` at 1 MiB and the whole report at 10 MiB.
- HTML is parsed and allowlisted: no JavaScript, iframes, objects/embeds,
  event handlers, external resource loads or form submission. External `<a>`
  navigation links are allowed; download remote images and add them with
  `add_asset`.
- The report is served at `/reports/<name>/` with a locked-down CSP. A report can
  be referenced by more than one message; the directory is removed when the last
  referencing message is deleted or evicted.

The tool is a thin POST to `${PIXIP_DAEMON_URL}/api/inbox`:

- `PIXIP_DAEMON_URL` is required and normally injected by the hub into every Pi
  child. Outside pixip, set it explicitly; the extension never guesses an
  address and never writes `<data-dir>/inbox.json`.
- `PIXIP_INBOX_TOKEN` is sent as `Authorization: Bearer` only when it is set.
- A missing daemon, wrong token or oversized body comes back as an actionable
  tool error string, not a crash. The tool does not list or read messages yet.

## Install / opt in

```bash
pi install /path/to/pixip/extensions/pixip-inbox
# or load it for one run:
pi -e /path/to/pixip/extensions/pixip-inbox/src/index.ts
```

pixip does not auto-register extensions: it spawns the real `pi` binary, so the
tool is available only in sessions whose extension set includes this package.
Existing extensions and the hub's plugin-transparency invariant are untouched.

## Develop

```bash
npm run check --workspace pixip-inbox
```

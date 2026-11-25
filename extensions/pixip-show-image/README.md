# pixip-show-image

A small Pi extension that registers `show_image_to_user`, the agent's explicit
way to show one local image to the user.

```ts
show_image_to_user({ path: "/abs/path/shot.png", caption?: "Login screen" })
```

- The path must be absolute. One image per call; PNG, JPEG, GIF and WebP are
  supported.
- Up to 1 MB: the image is returned unchanged.
- Over 1 MB, up to 20 MB: the extension returns a thumbnail (longest edge
  1024 px, at most 512 KB) and text saying the original is over the limit, with
  a download link.
- Over 20 MB, or when a thumbnail cannot be produced: no image, link only.
- Pi's own tool-result normalization still runs afterwards.

The result carries `details: { path, caption?, bytes, thumbnail, overSourceLimit, tooLarge }`.
Pixip uses that to render the image on the tool card and turn the `file://`
link into a working download; a plain Pi TUI keeps the `file://` link and the
image content is available to the model.

## Install

```bash
pi install /path/to/pixip/extensions/pixip-show-image
```

pixip does not auto-register the extension: it spawns the real `pi` binary, so
installing the package makes the tool available in every session that loads it.

## Develop

```bash
npm run check --workspace pixip-show-image
```

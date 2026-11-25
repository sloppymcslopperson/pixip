#!/usr/bin/env bash
# Live-reloading dev server for the design mockups in this directory.
#
#   ./dev.sh                 # http://127.0.0.1:8181/
#   ./dev.sh --port 9000     # extra args are passed to tools/dev-ui.mjs
#
# Serves this directory (whatever it is called), uncached, and reloads the tab
# when a file here changes. Ctrl-C to stop.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$here/.." && pwd)"

exec node "$repo/tools/dev-ui.mjs" --dir "$here" "$@"

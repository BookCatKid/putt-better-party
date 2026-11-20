#!/bin/bash
set -eu
cd "$(dirname "$0")/../.."
# shellcheck source=tests/integration/browser-env.sh
. tests/integration/browser-env.sh

launch_browser
cleanup() {
  cleanup_browser
}
trap cleanup EXIT

bun "${BROWSER_SCRIPT:-tests/integration/browser-lifecycle.mjs}"

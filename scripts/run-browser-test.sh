#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if curl -sf http://127.0.0.1:9239/json/version >/dev/null; then echo 'Debug port already in use'; exit 1; fi
profile=$(mktemp -d /tmp/putt-bp-chrome-test.XXXXXX)
"$CHROME" --headless=new --no-first-run --no-default-browser-check --disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-sync --disable-extensions --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1 --disable-dev-shm-usage --enable-unsafe-swiftshader --use-angle=swiftshader --remote-debugging-port=9239 --user-data-dir="$profile" about:blank >browser-chrome.log 2>&1 &
browser=$!
cleanup(){
 kill "$browser" 2>/dev/null || true
 wait "$browser" 2>/dev/null || true
 for _ in {1..10}; do rm -rf "$profile" 2>/dev/null && return 0; sleep .2; done
 echo "Warning: could not remove isolated browser test profile" >&2
}
trap cleanup EXIT
for _ in {1..50}; do curl -sf http://127.0.0.1:9239/json/version >/dev/null && break; sleep .2; done
bun "${BROWSER_SCRIPT:-scripts/browser-match.mjs}"

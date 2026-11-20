#!/bin/bash
# Shared browser environment for the integration runners. Sourced, not executed.
#
# Provides:
#   launch_browser  — resolve CHROME, start isolated headless Chrome on the CDP
#                     port, wait for /json/version. Sets `browser` and `profile`.
#   cleanup_browser — kill the browser and remove its temporary profile.
#
# The caller owns the EXIT trap and calls cleanup_browser from it, so a runner
# can combine browser cleanup with its own resources (server, database).

launch_browser() {
  if [[ -z "${CHROME:-}" ]]; then
    for candidate in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "$(command -v chromium || true)" \
      "$(command -v google-chrome || true)" \
      "$(command -v chromium-browser || true)"; do
      if [[ -x "$candidate" ]]; then CHROME="$candidate"; break; fi
    done
  fi
  if [[ ! -x "${CHROME:-}" ]]; then
    echo "Set CHROME to a Chromium-compatible executable." >&2
    exit 1
  fi
  if curl -sf http://127.0.0.1:9239/json/version >/dev/null; then
    echo 'Debug port already in use' >&2
    exit 1
  fi
  # SwiftShader keeps the suites runnable without a display, but two live WebGL
  # contexts stall for minutes while levels load and textures upload. macOS can
  # render headless with Metal, so prefer that; override with CHROME_GL=swiftshader
  # or another ANGLE backend name.
  local gl_flags=()
  if [[ -z "${CHROME_GL:-}" ]]; then
    if [[ "$(uname -s)" == Darwin ]]; then CHROME_GL=metal; else CHROME_GL=swiftshader; fi
  fi
  if [[ "$CHROME_GL" == swiftshader ]]; then
    gl_flags=(--enable-unsafe-swiftshader --use-angle=swiftshader)
  else
    gl_flags=(--use-angle="$CHROME_GL")
  fi
  profile=$(mktemp -d /tmp/putt-bp-chrome-test.XXXXXX)
  # shellcheck disable=SC2086
  "$CHROME" --headless=new --no-first-run --no-default-browser-check \
    --disable-background-networking --disable-background-timer-throttling \
    --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
    --disable-sync --disable-extensions --proxy-server=http://127.0.0.1:9 \
    --proxy-bypass-list=127.0.0.1 --disable-dev-shm-usage "${gl_flags[@]}" \
    --remote-debugging-port=9239 --user-data-dir="$profile" about:blank \
    >"${BROWSER_LOG:-browser-chrome.log}" 2>&1 &
  browser=$!
  for _ in {1..50}; do
    curl -sf -m 2 http://127.0.0.1:9239/json/version >/dev/null && return 0
    sleep .2
  done
  echo "Headless browser did not open its debugging port." >&2
  return 1
}

cleanup_browser() {
  if [[ -n "${browser:-}" ]]; then
    kill "$browser" 2>/dev/null || true
    wait "$browser" 2>/dev/null || true
  fi
  if [[ -n "${profile:-}" ]]; then
    for _ in {1..10}; do
      rm -rf "$profile" 2>/dev/null && return 0
      sleep .2
    done
    echo "Warning: could not remove isolated browser test profile" >&2
  fi
}

# A dead debugging port means the browser process is gone (a wedged renderer can
# take it down). The sweep checks this to report the case precisely rather than
# blaming the next check for a connection refusal it did not cause.
browser_alive() {
  curl -sf -m 5 http://127.0.0.1:9239/json/version >/dev/null
}

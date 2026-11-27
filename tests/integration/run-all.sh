#!/bin/bash
# The one integration command: an isolated temporary service and database, one
# headless browser, every check script in sequence, per-test timeouts and a
# summarized result. It refuses to touch anything already running — a live
# local service on the chosen port or an occupied debugging port — rather than
# interfere with it.
#
#   bun run test:integration
#
# Knobs (all optional):
#   BP_TEST_PORT     service port for the sweep (default 8799 — deliberately
#                    not 8789, which is where a developer's own service lives)
#   BP_TEST_TIMEOUT  per-script seconds before it is killed (default 300)
#   BP_TEST_SKIP     extra script names to skip, comma-separated
#   BP_TEST_ONLY     run only these script names, comma-separated
#   CHROME / CHROME_GL / BROWSER_LOG — see browser-env.sh
#
# check-admin joins only when BP_ADMIN_PASSWORD_HASH and BP_TEST_ADMIN_PASSWORD
# are both set (the service is started with the hash then); otherwise it is
# reported SKIPPED, which is a configuration limitation, not evidence.

set -u
cd "$(dirname "$0")/../.." || exit 1
# shellcheck source=tests/integration/browser-env.sh
. tests/integration/browser-env.sh

PORT="${BP_TEST_PORT:-8799}"
BASE="http://127.0.0.1:$PORT"
export BASE
TIMEOUT="${BP_TEST_TIMEOUT:-300}"

if curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "Refusing: $BASE already serves — a live service may be running there; set BP_TEST_PORT." >&2
  exit 1
fi
if [[ ! -f web/build.json ]]; then
  echo "No prepared client; run bun run prepare:client first." >&2
  exit 1
fi

logdir=$(mktemp -d -t bp-integration-logs.XXXXXX)
db="${logdir}/rooms.sqlite"
# check-shot-verification reads the service's own audit log for the verifier's
# verdict, so the sweep has to give the service a log to write. Without it the
# service writes no events and that check has nothing to assert against.
eventlog="${logdir}/events.jsonl"
export BP_EVENT_LOG="$eventlog"
# The trap is installed before anything is started so a failure at any later
# point — a browser that never opens its port, a service that never becomes
# healthy — still releases what did start. Empty defaults keep `set -u` happy.
server=
browser=
profile=
keep_logs=0
cleanup() {
  if [[ -n "$browser" ]]; then cleanup_browser; fi
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  if [[ $keep_logs -eq 0 ]]; then rm -rf "$logdir"; fi
}
trap cleanup EXIT

# The admin hash reaches the service only when the operator provided it; the
# matching script password reaches check-admin through the normal environment.
server_env=(PORT="$PORT" BP_DB="$db" BP_EVENT_LOG="$eventlog")
if [[ -n "${BP_ADMIN_PASSWORD_HASH:-}" ]]; then
  server_env+=(BP_ADMIN_PASSWORD_HASH="$BP_ADMIN_PASSWORD_HASH")
fi
env "${server_env[@]}" bun src/server.ts >"$logdir/server.log" 2>&1 &
server=$!

healthy=0
for _ in {1..150}; do
  curl -sf "$BASE/health" >/dev/null 2>&1 && { healthy=1; break; }
  sleep .2
done
if [[ $healthy -eq 0 ]]; then
  keep_logs=1
  echo "Service did not become healthy; see $logdir/server.log" >&2
  exit 1
fi

# Helpers and measurement tools are not checks; the documented headless-renderer
# stall and the optional admin suite are excluded by default.
#
# check-soak needs the service running with a short room clock (BP_ROOM_IDLE_MS /
# BP_ROOM_SWEEP_MS), which this sweep deliberately does not set: the sweep's
# service keeps production timing so the other checks see realistic rooms. The
# soak is run on purpose against a purpose-started service — see
# docs/development.md.
skips="cdp.mjs playlist-editor.mjs profile-load.mjs visual-regression.mjs check-voting.mjs"
skips="$skips check-soak.mjs"
if [[ -z "${BP_ADMIN_PASSWORD_HASH:-}" || -z "${BP_TEST_ADMIN_PASSWORD:-}" ]]; then
  skips="$skips check-admin.mjs"
fi
skips="$skips ${BP_TEST_SKIP//,/ }"

in_list() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

passed=0
failed=0
timed_out=0
skipped=0
fail_launch=0
declare -a failures=()

for script in tests/integration/*.mjs; do
  name=$(basename "$script")
  if [[ -n "${BP_TEST_ONLY:-}" ]] && ! in_list "${BP_TEST_ONLY//,/ }" "$name"; then
    continue
  fi
  if in_list "$skips" "$name"; then
    skipped=$((skipped + 1))
    printf 'SKIP  %s\n' "$name"
    continue
  fi
  # Every check gets a fresh browser process, which is exactly the environment
  # `BROWSER_SCRIPT=… bun run test:browser` gives it. Sharing one browser across
  # the sweep is not viable: a check that loads a second themed course wedges the
  # headless renderer (documented under "Known limits of the browser suite"), and
  # once that happens every later check inherits a dead or half-dead browser.
  # Restarting per check keeps one wedged check from cascading into fifty.
  if [[ -n "$browser" ]]; then
    cleanup_browser
    browser=
    profile=
  fi
  BROWSER_LOG="$logdir/$name.browser.log" launch_browser || {
    keep_logs=1
    echo "Browser launch failed before $name; see $logdir/$name.browser.log" >&2
    fail_launch=$((fail_launch + 1))
    continue
  }
  log="$logdir/$name.log"
  bun "$script" >"$log" 2>&1 &
  runner=$!
  (sleep "$TIMEOUT" && kill -9 "$runner" 2>/dev/null) &
  watchdog=$!
  wait "$runner"
  code=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  case $code in
    0)
      passed=$((passed + 1))
      printf 'PASS  %s\n' "$name"
      ;;
    137)
      timed_out=$((timed_out + 1))
      failures+=("$name")
      keep_logs=1
      printf 'TIME  %s  (> %ss)\n' "$name" "$TIMEOUT"
      ;;
    *)
      failed=$((failed + 1))
      failures+=("$name")
      keep_logs=1
      printf 'FAIL  %s  (exit %s)\n' "$name" "$code"
      ;;
  esac
done

echo
echo "==== $passed passed, $failed failed, $timed_out timed out, $skipped skipped ===="
if [[ $fail_launch -gt 0 ]]; then
  echo "$fail_launch check(s) never ran because a browser could not be launched."
fi
if [[ ${#failures[@]} -gt 0 ]]; then
  echo "Failures: ${failures[*]}"
  echo "Full logs: $logdir"
  exit 1
fi

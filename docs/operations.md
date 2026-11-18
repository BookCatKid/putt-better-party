# Operating the service

This is the runbook for a self-hosted Better Party instance: what to configure,
how to start and stop it, where its state lives, and what to do when something
goes wrong. The default local setup is deliberately the simplest path, and
everything below that is optional until you expose the service to other people.

## Running locally

Install Bun, Python 3 and curl, then:

```sh
bun install --frozen-lockfile
bun run prepare:client
bun run start
```

`prepare:client` verifies the archived client against `scripts/client-lock.json`
and builds the patched browser client offline. It is not optional: `web/` is a
generated directory and is not tracked, so a fresh clone has no client to serve
until it has run. The quality check runs it too, so `bun run check` also rebuilds
it.

Open <http://localhost:8789> or <http://127.0.0.1:8789>; both work, because a
local run answers every loopback spelling of its port.

## Configuration

Every value comes from the environment and has a safe default. See also the table
in the README.

| Variable                      | Default              | Meaning                                                                       |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `PORT`                        | `8789`               | HTTP and WebSocket port. Must be an integer in range or startup fails.        |
| `BP_HOST`                     | `127.0.0.1`          | Address the listener binds to.                                                |
| `BP_DB`                       | `state/rooms.sqlite` | SQLite database holding room checkpoints.                                     |
| `BP_PUBLIC_ORIGIN`            | unset                | A bare public origin. Setting it turns the service into a proxied deployment. |
| `BP_EVENT_LOG`                | unset                | Path for the private JSON-lines gameplay event log. Disabled when unset.      |
| `BP_ADMIN_PASSWORD_HASH`      | unset                | Argon2id hash enabling the read-only `/admin` dashboard.                      |
| `BP_TEST_FAIL_MAP_FETCH_CALL` | unset                | Test-only fault injection. Never set this in a real deployment.               |

The listener binds to loopback by default. `BP_PUBLIC_ORIGIN` is what makes a
reverse proxy authoritative: the service then answers **only** that origin, and a
direct loopback request is refused, so the proxy cannot be bypassed. Forwarded
headers (`X-Forwarded-For`, `X-Forwarded-Proto`) are not trusted, because without
a configured proxy a client can set them to anything. Supply the public origin
instead of relying on them.

To enable the admin dashboard, generate a hash rather than storing a password:

```sh
bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'your password here'
```

Put the output in `BP_ADMIN_PASSWORD_HASH` in the service's private environment.
Without it the admin API answers `503` and stays closed.

## Where state lives

- `state/rooms.sqlite` — room checkpoints: identity sessions, configuration,
  playlists, phases and scores. Created `0600` inside a `0700` directory.
- `state/rooms.sqlite-wal` and `-shm` — SQLite's write-ahead log and shared
  memory, managed by SQLite.
- `BP_EVENT_LOG` — private gameplay events, rotated at 8 MiB with six archives.
- `web/` — the generated client. Rebuild it with `bun run prepare:client`.
- `private-client/` — the archived original client. Source of truth for the
  build; never edited by hand.

Nothing under `state/` or `web/` belongs in version control, and neither do logs.
Back up the database as described below rather than copying a live file.

## Starting, stopping and restarting

`bun run start` runs in the foreground, which is the right default for local use
and for a process supervisor.

Stop it with `SIGTERM` (or Ctrl-C, which is `SIGINT`). The shutdown is ordered:
the listener stops, connected players receive close code **1001 "going away"** so
their clients reconnect rather than treating it as an outage, every room is
checkpointed, and only then does the database close. That checkpoint is what
flushes SQLite's write-ahead log to zero; a `SIGKILL` leaves it unflushed. A
stuck step cannot hold the process past a ten-second bound, and a second signal
does not restart the sequence.

Restarting is safe at any time. Rooms are restored from the database and mark
themselves as recovered, which the lobby already presents to players; a match that
was in progress returns to the lobby rather than resuming a half-played hole.

A process manager such as systemd or launchd should send `SIGTERM`, give it a few
seconds, and only then escalate. Do not run two instances against the same
database file.

## Health and readiness

`GET /health` is a liveness and shape signal, not a readiness one: it does not
check upstream reachability, because the catalog is a live remote dependency and
a transient upstream failure should not restart a healthy process with live
rooms. Use it to confirm the listener is up and to see whether upstream is the
reason something is slow.

```json
{
  "ok": true,
  "rooms": 3,
  "maps": 0,
  "players": 0,
  "activeMatches": 0,
  "uptimeSeconds": 8,
  "memory": { "rssBytes": 44318720, "heapUsedBytes": 3529601 },
  "upstream": {
    "queue": {
      "running": 0,
      "waiting": 0,
      "started": 0,
      "failed": 0,
      "averageLatencyMs": null,
      "slowestLatencyMs": 0
    },
    "caches": { "catalogPages": 0, "knownCourses": 0, "previews": 0 }
  }
}
```

What each field is for:

- `rooms` is the number of live parties and is the check to make after a
  restore. `players` counts connected sockets rather than issued identities, so a
  room full of offline players who may reconnect does not inflate it.
  `activeMatches` counts rooms past the lobby.
- `memory.heapUsedBytes` is the number that matters for spotting a leak;
  `rssBytes` includes memory the runtime will not return anyway. Neither is a
  budget: the service has no heap ceiling, so watch the trend rather than the
  value.
- `upstream.queue.started` and `failed` are lifetime counters since this process
  started, and reset on restart. A failure is counted in **both**, because it did
  start and it did cost latency; keeping it in the average but out of `failed`
  would hide a run of failures behind a plausible duration.
  `averageLatencyMs` is `null` until the first request finishes, because `0`
  would be indistinguishable from an instant response.
- Latency is measured around the upstream operation alone, not around the wait
  for a pacing slot. The wait is a consequence of the service's own pacing, so
  including it would make a slow upstream look healthy.
- `upstream.caches` reports sizes only, never contents. No room code, course,
  player name or credential appears in this response, because a health endpoint
  is often the least protected surface on a service.

`/health` accepts `GET` and `HEAD` and answers `405` otherwise.

## Backups

The database runs in WAL mode, so copying `rooms.sqlite` by hand is **not** a
backup: recent commits can still be only in the `-wal` file. Measured on a live
service with three rooms created, the WAL held 57712 bytes while the main file
was 4096 — a plain copy would have captured a database that looks intact and
contains nothing.

Use the bundled tool, which takes a consistent snapshot through SQLite's own
backup API and works against a running service:

```sh
bun run backup                                    # -> state/backups/rooms-<utc>.sqlite
python3 scripts/backup.py verify <file>           # integrity, room count, versions
bun run backup:prune --keep 7                     # keep the newest seven
```

`create` writes one self-contained file and then verifies it immediately, because
a backup that cannot be restored is worse than none. `verify` reports the room
count and the checkpoint version of every row, and warns when no room is a
version this build can read — that is what a rollback to an older build looks
like, and it is better to hear it now than at startup. `prune` keeps the newest
backups by timestamp and refuses `--keep 0`, so a prune can never leave you with
nothing.

Backups and their directory are created `0600` inside `0700`, and `verify`
refuses a file that is readable beyond its owner. They contain identity sessions
and host capabilities, so treat them exactly like the database itself: never
commit them, never attach them to an issue, and delete them when they age out.

To prove a restore, point `BP_DB` at a backup and start the service on another
port:

```sh
BP_DB=state/backups/rooms-2026-01-01T00-00-00-000Z.sqlite PORT=8790 bun run start
curl -s http://127.0.0.1:8790/health
```

The room count in `/health` is the check. Room state is expendable — losing it
loses parties in progress, not accounts — so a backup is a convenience rather
than a record of anything irreplaceable.

### Restoring after a version change

The loader skips a row it cannot read rather than deleting or rewriting it, so a
checkpoint written by a newer build is left intact for a later migration and
never becomes a crash. That has two consequences worth knowing:

- Rolling back to an older build over a database written by a newer one leaves
  the newer rows in place and skips them, so the older build starts without those
  rooms and the data is still there if you roll forward again.
- Rows untouched for 30 minutes are swept at startup, so a pending migration has
  a window rather than forever. Take a backup before any version change, which
  `verify` then lets you inspect to confirm what the old build could read.

## Recovering from problems

- **The client will not load.** `web/` is missing or stale. Run
  `bun run prepare:client`.
- **Every request answers `403 Invalid host`.** The `Host` header did not match
  the configured origins. Check `BP_PUBLIC_ORIGIN` and that the proxy passes the
  public host through unchanged.
- **A write answers `403 Invalid origin`.** The browser's origin did not match an
  allowed origin. This is expected when the page is opened by a name the service
  was not configured for.
- **The catalog is empty or a party will not start.** The public catalog is a live
  remote dependency. Check the service's upstream access; queued and cached
  requests are bounded, so a prolonged outage shows as an empty or slow catalog
  rather than unbounded growth.
- **A party vanished.** Empty rooms are reclaimed 30 minutes after their last
  activity, including rooms nobody ever joined. That is deliberate.
- **The admin dashboard answers `503`.** `BP_ADMIN_PASSWORD_HASH` is unset or not
  a hash this Bun version accepts. Regenerate it as shown above.

## Exposing the service

Do not expose the service publicly without deciding the questions this project
cannot decide for you. Serve the original client only where you have the right to
do so (see the asset-rights note in the README), terminate TLS at the proxy, set
`BP_PUBLIC_ORIGIN` to the public origin so the proxy is authoritative, and keep
the database, the event log and any backups private.

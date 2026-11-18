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

`GET /health` answers `{"ok":true,"rooms":N,"maps":M}`. It is a liveness signal,
not a readiness one: it does not check upstream reachability, because the catalog
is a live remote dependency and a transient upstream failure should not restart a
healthy process with live rooms. Use it to confirm the listener is up.

## Backups

The database runs in WAL mode, so copying `rooms.sqlite` on its own from a live
service can miss recent commits. Either stop the service first — a `SIGTERM`
checkpoints the log — or take a consistent copy with SQLite's own tooling (the
`sqlite3` command line is not needed to run the service, only for this):

```sh
sqlite3 state/rooms.sqlite ".backup 'state/backup-$(date +%F).sqlite'"
```

Keep backups as private as the original: they contain identity sessions and host
capabilities. Verify a restore by copying the backup to a scratch path, pointing
`BP_DB` at it, and confirming the rooms appear. Room state is expendable — losing
it loses parties in progress, not accounts — so a backup is a convenience rather
than a record of anything irreplaceable.

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

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

### Match history

A room checkpoint also carries the last **ten completed matches** for that party: the
public course ids, titles and pars, and each player's display name, rank, holes
survived, strokes and time. It survives a rematch and a server restart. It is
deliberately **not** a recording: no course specification, geometry, socket, session or
capability token is stored in it, so a history entry cannot be used to replay a course
or to rejoin as somebody. The current match's per-hole rounds are separate and are
cleared by a rematch; the history is not. Older checkpoints without a history load
with an empty one.

### Exporting results

Two exports, both built by explicit projection rather than serialising the store, so
nothing private can ride along:

- **CSV** (`Export CSV` on the scorecard) is the current match as a scorecard: a
  course row, a par row, a header row and one row per player with the same numbers and
  the same named states the screen shows (`Skip`, `DNF`, `End`, and a real score for a
  timeout).
- **JSON** (`Export history (JSON)` in the lobby) is the whole retained history, not
  just the five rows the panel shows: `{format: "better-party.results", version: 1,
matches: [...]}`.

Neither contains a uid, session, host token, connection id, ball cosmetic, course
specification or internal `matchId`. Both are downloaded as files rather than copied to
the clipboard, so they need no clipboard permission and work on a phone.
`tests/results-export.test.js` asserts the exact projections, and
`check-results-export.mjs` captures the actual downloads in a browser and checks them.

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
do so (see the asset-rights note in the README).

The service never terminates TLS itself. It speaks plain HTTP and WebSocket, and
a reverse proxy in front of it is what makes the deployment HTTPS. The pieces
that have to line up are the origin, the upgrade, the timeouts, and the
knowledge that the service cannot see the client's address.

### Required configuration

```sh
BP_HOST=127.0.0.1                       # only the proxy may reach it
BP_PUBLIC_ORIGIN=https://party.example.com   # authoritative, and turns on HSTS
BP_DB=/var/lib/better-party/rooms.sqlite
BP_EVENT_LOG=/var/log/better-party/events.jsonl
```

Setting `BP_PUBLIC_ORIGIN` has three consequences worth stating plainly:

- The service answers **only** that origin. A direct loopback request is
  refused with `403`, so the proxy cannot be bypassed by reaching the port
  another way. Verified: a proxied deployment answers `403` to a loopback `Host`.
- An `https:` origin marks the deployment as TLS-terminated. `Secure` is added to
  the admin cookie, and `Strict-Transport-Security: max-age=31536000;
includeSubDomains` is sent on every response.
- The WebSocket scheme in the CSP becomes `wss:`, so the browser will accept the
  socket at the public origin.

Forwarded headers are **not** trusted, with or without a proxy. Without a
configured proxy a client can set `X-Forwarded-For` to anything, so trusting it
would let anyone forge an address; with one configured, the public origin is
already exact. Supply `BP_PUBLIC_ORIGIN` instead of relying on them.

The consequence is that the service cannot see the real client address: every
request appears to come from the proxy. If you need per-client identity in an
upstream log, that belongs at the proxy, not in this service.

### Caddy

Caddy obtains and renews a certificate automatically and proxies WebSockets
without extra configuration:

```
party.example.com {
	reverse_proxy 127.0.0.1:8789
}
```

### nginx

WebSocket needs the upgrade headers explicitly, and the proxy's read timeout must
exceed the server's own idle timeout or it will close a healthy socket during a
quiet lobby:

```nginx
server {
	listen 443 ssl;
	server_name party.example.com;

	ssl_certificate     /etc/letsencrypt/live/party.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/party.example.com/privkey.pem;

	location / {
		proxy_pass http://127.0.0.1:8789;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host $host;
		# The server closes an idle WebSocket after 120 s, so the proxy must wait
		# longer; otherwise it drops a socket the server still considers open.
		proxy_read_timeout 3600s;
		proxy_send_timeout 3600s;
	}
}
```

Two numbers have to stay in the right order, and both were taken from the code
rather than guessed:

- **The WebSocket idle timeout is 120 seconds** (`idleTimeout` in `src/server.ts`).
- **The client sends a heartbeat every 15 seconds** and treats two unanswered
  pings as a dead connection (`scripts/party-transport.js`). So a healthy party
  traffic never approaches 120 s, and a proxy timeout below it would break a
  socket while both ends believed it was fine.

Do not set a proxy request-body limit below the service's own:
`MAX_JSON_BODY_BYTES` is 1,000,000 bytes, and the service answers with its own
status when a body exceeds it, which is more useful than the proxy's generic
error.

### Verifying the deployment

```sh
curl -sI https://party.example.com/ | grep -iE 'strict-transport|permissions-policy'
curl -s  https://party.example.com/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8789/   # expect 403
```

The first should show HSTS and the permissions policy, the second should report
`ok`, and the third should be refused because only the proxy may talk to the
port. A `403` on the third is the check that the proxy is authoritative rather
than decorative.

## Running in a container

`Dockerfile` and `docker-compose.yml` build a runtime image and run the service
as a non-root user with a read-only filesystem. Both were built and run on an
`aarch64` Ubuntu 24.04 host to confirm the architecture claim below.

### Why the client is not in the image

This is the detail that matters most, and it is also the one most likely to be
"simplified" by someone who has not read the licensing position. The service
serves a client derived from the original game's bundles. Those bundles are
archived in `private-client/` and are **not independently licensed**, so an image
containing them would make every pull of that image a redistribution.

The image therefore carries this project's own source and nothing else. The
build verified this directly: `/app/web` and `/app/private-client` contain **zero
files** in the finished image, and `/app/private-client` does not exist at all
unless it is mounted. The prepared client and the three original bundles are bind
mounts.

Those three bundles are needed because the server's upstream adapter imports them
directly by relative path — `date-*.js` and `createServerFn-*.js`, the latter
pulling in `redirect-*.js`. Without them the process does not start, and the
error names the missing module rather than failing obscurely:

```
error: Cannot find module '../../web/validation/specValidation-vqop-JBL.js'
```

That is deliberate: an image missing its mount fails at startup instead of
serving a broken page.

### Prepare the host

```sh
sudo mkdir -p /srv/party/state /srv/party/web /srv/party/private-client/assets
sudo chown -R 10001:10001 /srv/party/state
```

`10001` is the runtime user, fixed numerically so a data directory prepared once
does not need re-chowning after a rebuild. Only `state` is writable by it;
`web` and the archived bundles are read-only.

The prepared client needs the generated validation closure as well as the
patched bundles, because the adapter imports from `web/validation`. The supported
way to produce the whole thing is `bun run prepare:client`, which fails offline
rather than fetching anything and verifies every archived hash first. Copy the
resulting `web/` and the three bundled files above into the mount points.

### Run

```sh
docker compose up -d --build
```

Set `PARTY_PORT` if something already holds 8789, which on a busy host is often
a proxy:

```sh
PARTY_PORT=8797 docker compose up -d
```

Without compose, the equivalent:

```sh
docker build -t better-party:local .
docker run -d --name party \
  --read-only \
  --mount type=bind,src=/srv/party/state,dst=/app/state \
  --mount type=bind,src=/srv/party/web,dst=/app/web,readonly \
  --mount type=bind,src=/srv/party/private-client/assets,dst=/app/private-client/assets,readonly \
  -p 127.0.0.1:8789:8789 \
  better-party:local
```

### What was verified

Run through compose on the ARM64 host, against a prepared client mounted
read-only:

- The container reaches **healthy** on its own health check.
- It serves a real page and a real client asset (`200`), and the client scripts
  are transpiled from their TypeScript sources at request time inside the
  container, so the image does not need a build step for them.
- With `BP_PUBLIC_ORIGIN` set, a loopback `Host` is refused with `403` and the
  public one gets `200`, so the proxy remains authoritative.
- `strict-transport-security`, `permissions-policy` and `x-frame-options` are
  all present.
- The root filesystem is read-only: writing to `/app/src` and `/app/web` fails
  with `Read-only file system`, while `/app/state` is writable. The writable
  surface is exactly the one directory that needs it.
- A room created inside the container is written to the host mount as `0600`
  files.
- `docker stop` takes the ordered shutdown path: exit code `0`, and the
  41232-byte write-ahead log is folded into a 24576-byte main file with no `-wal`
  left behind. Restarting the container restores that room from the mount.

### The health check

`scripts/container-health.js` runs inside the container, because `curl` is not in
the runtime image. It is not a plain `fetch('/health')`: the service refuses any
request whose `Host` is not configured, so a probe sending `127.0.0.1` would get
`403` from a perfectly healthy proxied deployment. The probe derives `Host` from
`BP_PUBLIC_ORIGIN` when set and falls back to loopback otherwise. Verified in
three states: `0` when healthy, `0` on a local run, and `1` both when the server
is down and when a proxied deployment is probed with the wrong `Host`.

### Architecture

The image is `linux/arm64` when built on the ARM64 host and `linux/amd64` when
built on x86. Nothing in it is architecture specific — there are no compiled
addons, no native modules and no runtime npm dependencies at all, since every
import is relative or a `bun:`/`node:` builtin. The base is `oven/bun:1.4.2-alpine`
at a pinned tag, which is the only version pin that matters here precisely
because there is no dependency tree to freeze.

### Least privilege

The process runs as uid/gid `10001`, the filesystem is read-only apart from one
mounted directory, `no-new-privileges` is set in the compose file, and `EXPOSE`
publishes nothing on its own — the compose port is bound to `127.0.0.1` so a TLS
proxy is still required to reach it. Use the exec form of `CMD` (as the
Dockerfile does) so the process is PID 1 and receives `SIGTERM` directly; a shell
wrapper would swallow the signal and the ordered shutdown would run into its
timeout instead.

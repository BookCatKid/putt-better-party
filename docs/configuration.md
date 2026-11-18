# Configuration reference

Everything configurable is read from the environment at startup. Every value has
a safe default, and an invalid value fails startup rather than being silently
corrected — a mistyped port that quietly becomes the default is a debugging
session nobody needs.

Room settings are different: they are chosen per party by the host through the
client, validated on the server, and persisted with the room. They are listed
here because their bounds are part of the service's behaviour, not because you
configure them from a shell.

## Environment

| Variable                      | Default              | Accepted values                                           |
| ----------------------------- | -------------------- | --------------------------------------------------------- |
| `PORT`                        | `8789`               | Integer 1–65535                                           |
| `BP_HOST`                     | `127.0.0.1`          | Any address the listener can bind                         |
| `BP_DB`                       | `state/rooms.sqlite` | Path to the SQLite file                                   |
| `BP_PUBLIC_ORIGIN`            | unset                | Bare `http`/`https` origin with no path or query          |
| `BP_EVENT_LOG`                | unset                | Path to a JSON-lines event log; disabled when unset       |
| `BP_ADMIN_PASSWORD_HASH`      | unset                | Argon2id hash; the admin API answers `503` without it     |
| `BP_TEST_FAIL_MAP_FETCH_CALL` | unset                | **Test only.** Fault injection; never set in a deployment |

### `PORT`

Must be an integer in range, otherwise startup fails with
`PORT must be an integer between 1 and 65535`. A float, a negative number or a
non-numeric string is rejected rather than truncated, so `PORT=8789.5` is an
error and not a surprise.

### `BP_HOST`

The bind address. The default is `127.0.0.1`, so **nothing off the machine can
reach the service** until you change this or put a proxy in front. `0.0.0.0`
makes it reachable on every interface, which is what the container image sets
because the container's network namespace is already private.

Binding is independent of the origin allowlist below. Setting `BP_HOST=0.0.0.0`
does not widen which `Host` values are answered.

### `BP_DB`

The SQLite database holding room checkpoints. Its directory is created with mode
`0700` if absent, and the file with mode `0600`. It contains room credentials, so
treat it as private: it is in `.gitignore` along with the `-wal` and `-shm`
siblings.

Set this to move state onto a different volume, or to run two instances against
different databases.

### `BP_PUBLIC_ORIGIN`

The single most consequential setting, and the one to get right before exposing
the service.

Unset, the service is a **local run**: it answers every loopback spelling of its
port — `http://127.0.0.1:8789`, `http://localhost:8789` and `http://[::1]:8789` —
so a browser that opened the page at `localhost` is not refused by a server that
only knows `127.0.0.1`. Both common spellings are verified working.

Set to a bare origin such as `https://party.example.com`, it becomes a **proxied
deployment**: that origin becomes the _only_ one answered, and a direct loopback
request is **refused with `403`**, so the proxy cannot be bypassed by reaching the
port directly. This is deliberate and is the intended behaviour when a proxy
terminates TLS.

The value must be a bare origin. A path, query, fragment or embedded credentials
are rejected, because a path would silently never match a real `Origin` header:

| Value                               | Result                          |
| ----------------------------------- | ------------------------------- |
| `https://party.example.com`         | Accepted                        |
| `https://party.example.com/`        | Accepted (normalised)           |
| `https://party.example.com/party`   | Rejected: no path               |
| `https://party.example.com?a=1`     | Rejected: no query              |
| `ftp://party.example.com`           | Rejected: must be http or https |
| `https://user:pw@party.example.com` | Rejected: no credentials        |
| `party.example.com`                 | Rejected: must be absolute      |

Setting an `https` origin also switches on transport-security behaviour: HSTS is
sent, and the admin cookie gains `Secure`. Both would be wrong on plain HTTP —
HSTS would pin the host and break later local requests, and a `Secure` cookie
would stop the admin session working at all — so a plain-HTTP deployment
correctly gets neither.

**Forwarded headers are never trusted.** `X-Forwarded-For` and
`X-Forwarded-Proto` are not read, because without a configured proxy any client
can set them to anything. Supply `BP_PUBLIC_ORIGIN` instead.

### `BP_EVENT_LOG`

Enables a private JSON-lines gameplay event log. Unset, logging is off and no file
is opened.

When set, the log rotates at **8 MiB** and keeps **6** archives. A record whose
serialised line would exceed **512 KiB** is replaced by a small marker carrying
`oversizedRecord: true` rather than written in full, so one pathological record
cannot fill the disk. Authentication credentials are omitted from every record.
Keep the file out of Git; the default `state/` location is already ignored.

### `BP_ADMIN_PASSWORD_HASH`

Enables the read-only `/admin` dashboard. Store a hash, never a password:

```sh
bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'your password here'
```

Without it the admin API answers `503` and stays closed, which is the safe
default. Login is rate limited to **5 attempts per 60 seconds**, and a session
lasts **8 hours**. The cookie is `HttpOnly`, `SameSite=Strict`, scoped to
`/api/admin`, and `Secure` only on an HTTPS deployment.

### `BP_TEST_FAIL_MAP_FETCH_CALL`

Fault injection used by one browser regression, which starts its own service and
makes a chosen course-load call fail. It has no place in a real deployment, and
setting it there would break course loading on purpose.

## Room settings

Chosen by the host in the client, validated by the server, and persisted with the
room. Defaults are what a new party gets.

| Setting           | Default  | Bounds                                                                  |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `holes`           | `3`      | 1–10 000 for a random party; up to 500 stored ids for a manual playlist |
| `timerMs`         | `60000`  | 0–86 400 000 ms; `0` means no round timer                               |
| `elimination`     | `true`   | boolean                                                                 |
| `maxPlayers`      | `50`     | 1–50                                                                    |
| `mapSource`       | `random` | `random` or `picked`                                                    |
| `selectedHoleIds` | `[]`     | Up to 500 ids when `mapSource` is `picked`                              |
| `locked`          | `false`  | boolean; refuses new joins                                              |
| `excludeDaily`    | `false`  | boolean; omits previously featured dailies                              |
| `randomHoles`     | `3`      | 1–10 000                                                                |
| `lateJoin`        | `always` | `never`, `next-hole` or `always`                                        |
| `courseVoting`    | `false`  | boolean                                                                 |

The `holes` range deserves explanation, because the two numbers look
inconsistent. A **random** party accepts any count from 1 to 10 000: the client
offers a slider up to nine, but the field also accepts a typed value, and the
server does not restrict the room to what its slider can display. A **manual
playlist has no upper bound in the room** — you can order as many courses as you
like, including duplicates — and the 500 limit is a persistence resource limit,
not a protocol rule. The largest playlist in the test suite is 153 courses.

`timerMs: 0` is a distinct mode, not a mistake: it means **the round has no
timer**, and the client shows `Unlimited` instead of a countdown. Every place the
deadline is used guards against it, so a zero timer does not expire the hole
instantly — which is precisely what an unguarded `startsAt + timerMs` would do.

Both behaviours were checked against a live room rather than read off the source:

| Attempt                             | Result                      |
| ----------------------------------- | --------------------------- |
| `mapSource: random`, `holes: 9`     | Accepted                    |
| `mapSource: random`, `holes: 10`    | Accepted — `holes` is 10    |
| `mapSource: random`, `holes: 10000` | Accepted                    |
| `mapSource: random`, `holes: 10001` | Refused, `invalid-config`   |
| `timerMs: 0`                        | Accepted — no round timer   |
| `timerMs: 1800000`                  | Accepted — 30 minutes       |
| `timerMs: 86400000`                 | Accepted — 24 hours         |
| `timerMs: 86401000`                 | Refused, `invalid-config`   |
| `maxPlayers: 51`                    | Refused, `invalid-config`   |
| `maxPlayers: 50`                    | Accepted                    |
| `mapSource: picked`, 12 courses     | Accepted, `holes` became 12 |

The picked row is the one that matters for the no-cap guarantee: a 12-course
playlist produces a 12-hole party, so the random-source bound is not leaking into
picked parties through a shared validator.

## Service limits

These are not configurable. They are listed so the behaviour is predictable
rather than surprising.

### Abuse budgets

| Limit            | Value                               |
| ---------------- | ----------------------------------- |
| Message burst    | 120 messages, refilled at 60/second |
| Scoreboard burst | 10 messages, refilled at 4/second   |
| JSON body        | 1 000 000 bytes                     |
| Relayed response | 2 000 000 bytes                     |
| Saved playlist   | 100 courses                         |
| Waiting previews | 64                                  |

A refused message is dropped silently, with one `message_budget_exhausted` audit
record rather than a reply per refusal — replying to each would itself be the
amplification an attacker wants.

### Timing

| Behaviour              | Value     |
| ---------------------- | --------- |
| Ready grace window     | 10 000 ms |
| Host succession grace  | 30 000 ms |
| WebSocket idle timeout | 120 s     |

The ready grace bounds how long a late client can extend the start of a hole: it
may only push `playNotBefore` forward, and only within 10 s, so one slow client
cannot hold a party indefinitely. The host succession grace means a host whose
connection drops keeps authority for 30 s — a refresh or a brief network blip does
not hand the party to somebody else — while explicitly leaving hands it over at
once.

### Upstream access

The service calls the public putt.day catalog and does not proxy gameplay to it.
Requests are paced at **one per 350 ms** with at most **3 in flight**, so a burst
of parties cannot turn into a burst against a service this project does not own.
Results are cached: catalog pages for **120 s**, previews for **300 s**, previews
capped at **2 000 000 bytes**.

A catalogue fetch is slow — a live measurement was about 5 seconds — which is why
that caching exists and why the first load of a party feels slower than later
ones.

## Storage

| Path                 | Created                 | Mode   | Purpose                             |
| -------------------- | ----------------------- | ------ | ----------------------------------- |
| `state/`             | on first run            | `0700` | Private state directory             |
| `state/rooms.sqlite` | on first run            | `0600` | Room checkpoints, identity sessions |
| `state/events/…`     | when `BP_EVENT_LOG` set | `0600` | Rotated gameplay log                |

Neither `state/` nor `web/` is in Git. `web/` is generated by
`bun run prepare:client` and is about 23 MB.

## What is not configurable, and why

- **CORS.** No `Access-Control-Allow-*` header is ever emitted. The client is
  served from the same origin, so nothing needs it, and emitting one would create
  a hole that no feature requires.
- **Forwarded headers.** Not trusted, for the reason given under
  `BP_PUBLIC_ORIGIN`. The proxy configuration is the place to be authoritative,
  not a request header.
- **The upstream origin.** Pinned to `https://putt.day` and checked on every
  outbound URL, because the recovered server functions and their argument shapes
  are specific to it. Pointing elsewhere would not produce a working game.

## Related

- [Installation](installation.md) for getting a working instance.
- [Operations](operations.md) for exposure, backups, restarts and containers.
- [Architecture](architecture.md) for how the pieces fit together.

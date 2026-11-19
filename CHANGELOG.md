# Changelog

All notable, user-visible changes to Better Party. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How versions are assigned

There was no version anywhere before this file existed — no tag, no
`package.json` field, no constant. The first release is therefore **1.0.0**, and
the version now lives in one place, `package.json`, which `/health` reports.

Three different things are versioned in this project, and they are deliberately
independent:

| Version        | Where                                               | Changes when                                                  |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| **Service**    | `package.json`, reported at `/health`               | A release is published                                        |
| **Protocol**   | `protocol.ts`, sent as `protocol: 2` on join        | A frame changes shape in a way an older client cannot survive |
| **Checkpoint** | `CHECKPOINT_VERSION` in `persistence-validation.ts` | The stored room format changes incompatibly                   |

The distinction matters when upgrading. A **patch** release never touches the
protocol or the checkpoint format. A **minor** release may add frames or settings
but old clients still work, and old checkpoints still load. A **major** release
may require a new client, or refuse to load a checkpoint written by an older
build — and if it does, that is stated in the entry rather than left to be
discovered during an upgrade.

Semantic versioning is applied to what a **self-hoster** experiences, not to
commit count. A change that forces someone to re-prepare the client or that
alters room behaviour is at least a minor bump even if the diff is small.

## [Unreleased]

### Added

- The project is now licensed: independently authored code under
  GPL-3.0-or-later (`LICENSE`), with `NOTICE` documenting that the archived
  original client and the prepared client built from it are excluded.

## [1.0.0] — 2026-11-18

The first tagged release. It is a snapshot of a codebase that had been developed
against a backlog without version numbers, so the entry below groups what
exists rather than pretending to be a diff from an earlier release.

### Playing

- Parties on public community courses, played with the original game engine and
  its physics unchanged.
- Manual playlists with no upper bound in the room: order as many courses as you
  like, duplicates included. The random source accepts 1–10 000 holes.
- Random course selection without repeats, with a history that survives a
  restart and an option to exclude previously featured dailies. Historical
  exclusion is checked against the site's own archive, and the daily list is
  treated as authoritative because it is what the game itself shows.
- Per-party settings: round duration (including **no timer**), elimination or
  stroke play, maximum players, admission policy, course voting and late joining.
- Host controls: extend time, skip a course, restart a round, end a match, hand
  the party over, retry or skip a failed next-course load, and lock the lobby.
- Per-hole scorecards, final standings, personal bests and a leaderboard.
- Spectating as an explicit choice rather than an accident of arrival.
- Rejoining keeps your identity and your room's settings, including across a
  service restart.

### Operating

- Room state persists in SQLite and survives restarts. An interrupted match
  returns to the lobby rather than resuming mid-hole with stale scores.
- Ordered shutdown on `SIGTERM`/`SIGINT`: cancel timers, stop the listener, close
  sockets, checkpoint every room, close the database. Measured on a live room, it
  folded a 41 232-byte write-ahead log into a 24 576-byte main file.
- `/health` reports version, room and player counts, memory, and upstream queue
  depth and latency, so "is it us or is it upstream" is answerable without
  reading logs.
- `scripts/backup.py` for `create`, `verify` and `prune`, using SQLite's backup
  API so a live write-ahead log is captured correctly rather than copied blindly.
- A private JSON-lines gameplay log, off by default, rotating at 8 MiB with six
  archives and no credentials in any record.
- A password-protected read-only admin dashboard.
- Configuration through seven environment variables, all with safe defaults and
  an invalid value failing startup rather than being silently corrected.
- A container image that deliberately carries **no** client assets, because they
  are not independently licensed; the prepared client and the three original
  bundles are read-only mounts.

### Security

Security was reviewed as a set of specific properties rather than a general
claim, and each of these has a test or a recorded verification:

- The listener binds to loopback by default.
- A configured public origin becomes the **only** origin answered; a direct
  loopback request is refused `403`, so a proxy cannot be bypassed. An unset
  origin answers every loopback spelling, so `localhost` and `127.0.0.1` both
  work locally.
- Forwarded headers are never trusted, because without a configured proxy any
  client can set them.
- No `Access-Control-*` header is emitted on any response, including `OPTIONS`.
- Host and origin are checked exactly, not by prefix or suffix, so a hostile DNS
  name cannot borrow the allowance.
- Message and scoreboard budgets are per-connection token buckets, refilled at 60
  and 4 per second. A refusal is silent with one audit record, because replying
  to each refusal is itself the amplification.
- Room uploads are bounded (1 MB JSON body, 2 MB relayed response, 100-course
  saved playlist) and stored checkpoints are validated before they are restored,
  so a corrupt or hostile row is rejected instead of trusted.
- No frame, projection or log record carries a session secret or another
  player's credential; the tests assert this rather than the docs.
- Transport-security headers — HSTS, a frame policy, a permissions policy — are
  applied once at the edge rather than per route. HSTS is sent **only** on an
  HTTPS deployment, because on plain HTTP it would pin the host and refuse later
  local requests.
- The permissions policy denies only capabilities the client does not use;
  `fullscreen` and `clipboard` stay enabled because the bundle calls them, and a
  test asserts they remain enabled.

### Compatibility

- Requires **Bun 1.4.2** and **Python 3.9+**. Node.js is needed only for the
  pre-commit hook.
- Upstream is the public putt.day service. Requests are paced at one per 350 ms
  with at most three in flight, and catalog results are cached, because this
  project does not own the service it reads from.
- **Physics is client-reported.** The server does not simulate shots, so a
  modified client can report a score it did not earn. This is a known limitation
  of the architecture, not an oversight, and it is why room admission and host
  authority are enforced server-side even though scoring is not.
- Upstream changes can require a compatibility update. The archived client is
  pinned by SHA-256 and preparation is offline, so an upstream release cannot
  change what you are running until someone deliberately updates the archive.
- The original client and game assets belong to their rights holders. They are
  archived for private development and are **not** redistributed by this project;
  see the README for the position on public deployment.

### Not included

- A license for the original assets. Independently authored code awaits an owner
  decision; there is no `LICENSE` file yet.
- Deployment to a public host. The service is verified behind a TLS proxy, but
  operating a public instance is a decision for the owner, not a code change.
- Anti-cheat beyond what is described above.

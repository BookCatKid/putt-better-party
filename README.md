<p align="center">
  <img src="docs/logo.png" alt="Better Party" width="400">
</p>

<p align="center">
  An independent, self-hosted multiplayer party service for putt.day.
</p>

<p align="center">
  <a href="https://github.com/BookCatKid/putt-better-party/actions/workflows/ci.yml"><img src="https://github.com/BookCatKid/putt-better-party/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

## Features

- Play public community courses with friends using the original game engine.
- Build, reorder and save custom playlists without a nine-hole cap.
- Randomize courses without repeats, optionally excluding previously featured dailies.
- Configure round duration, elimination, maximum players and room admission.
- Manage matches with host controls: extend time, skip, restart and end rounds.
- Review per-hole scorecards and final standings.
- Rejoin with the same identity and recover room settings after service restarts.

## Getting started

Install [Bun](https://bun.sh/), Python 3 and curl. From a clone of this repository:

```sh
bun install --frozen-lockfile
bun run hooks:install
bun run prepare:client
bun run start
```

Open [http://localhost:8789](http://localhost:8789), create a party and share its invite code. Course metadata and specifications are retrieved from the public putt.day catalog; All original client assets from the reviewed snapshot are retained in this private repository so they survive upstream updates. Preparation verifies their SHA-256 hashes and builds the patched client entirely offline.

The [installation guide](docs/installation.md) covers exact versions, what each step does, the failure modes of client preparation, and how to verify a working install.

## Architecture

Better Party implements its own room authority, WebSocket transport and persistent settings while retaining the original physics and rendering engine. The client preparation process verifies every archived upstream asset hash and applies narrowly scoped compatibility changes to generated copies.

| Directory  | Purpose                                                |
| ---------- | ------------------------------------------------------ |
| `src/`     | HTTP service, room lifecycle, catalog and persistence  |
| `scripts/` | Client capture, verification and compatibility patches |
| `tests/`   | Unit and integration tests                             |
| `docs/`    | Architecture and development documentation             |

Read the [development guide](docs/development.md) for quality checks, testing and upstream updates, the [configuration reference](docs/configuration.md) for every setting, limit and default, and the [operations guide](docs/operations.md) for restart, backup, exposure and containers. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing behaviour, [CHANGELOG.md](CHANGELOG.md) for what has changed between releases, and [docs/release.md](docs/release.md) for how a source-only release is built.

## Configuration

| Variable           | Default                    | Description                                          |
| ------------------ | -------------------------- | ---------------------------------------------------- |
| `PORT`             | `8789`                     | HTTP and WebSocket port                              |
| `BP_HOST`          | `127.0.0.1`                | Address the listener binds to                        |
| `BP_DB`            | `state/rooms.sqlite`       | SQLite room database                                 |
| `BP_PUBLIC_ORIGIN` | Local HTTP loopback origin | Exact public origin for a reverse-proxied deployment |
| `BP_EVENT_LOG`     | Unset (disabled)           | Private JSON-lines gameplay event log path           |

The service binds to loopback by default and answers `127.0.0.1` and `localhost` for its port, so either local spelling works in a browser. Setting `BP_PUBLIC_ORIGIN` to a bare origin such as `https://party.example.com` turns the service into a proxied deployment: that origin becomes the only one it answers, and a direct loopback request is refused, so the proxy cannot be bypassed. Forwarded headers are not trusted, because trusting them without a configured proxy lets a client choose its own address. Review deployment security before exposing it publicly. Room credentials are stored in the database; keep database backups private. For persistent gameplay logging, set `BP_EVENT_LOG` to a path under the private state directory. Logs rotate at 8 MiB with six archives and omit authentication credentials. Do not commit logs or runtime state.

## Compatibility and limitations

Better Party is an independent project and is not affiliated with putt.day. The archived original client and game assets belong to their respective rights holders. The asset archive is for private development and is not independently licensed by this project. Obtain appropriate permission before redistribution or public deployment.

Room settings and sessions survive restarts; interrupted matches return to the lobby. Scoring penalties and tie-breaking are independent policies, and physics results are client-reported. Upstream changes can require a compatibility update. See [architecture and operation](docs/architecture.md) for details.

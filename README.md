<p align="center">
  <img src="docs/logo.svg" alt="Better Party" width="480">
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
bun run prepare:client
bun run start
```

Open [http://localhost:8789](http://localhost:8789), create a party and share its invite code. Course metadata and specifications are retrieved from the public putt.day catalog; downloaded client assets are not included in this repository.

## Architecture

Better Party implements its own room authority, WebSocket transport and persistent settings while retaining the original physics and rendering engine. The client preparation process verifies pinned upstream bundle hashes and applies narrowly scoped compatibility changes to generated copies.

| Directory  | Purpose                                                |
| ---------- | ------------------------------------------------------ |
| `src/`     | HTTP service, room lifecycle, catalog and persistence  |
| `scripts/` | Client capture, verification and compatibility patches |
| `tests/`   | Unit and integration tests                             |
| `docs/`    | Architecture and development documentation             |

Read the [development guide](docs/development.md) for quality checks, testing and upstream updates.

## Configuration

| Variable | Default              | Description             |
| -------- | -------------------- | ----------------------- |
| `PORT`   | `8789`               | HTTP and WebSocket port |
| `BP_DB`  | `state/rooms.sqlite` | SQLite room database    |

The service binds to loopback by default. Review deployment security before exposing it publicly. Room credentials are stored in the database; keep database backups private.

## Compatibility and limitations

Better Party is an independent project and is not affiliated with putt.day. The original client and game assets belong to their respective rights holders and are obtained separately from the public site. Obtain appropriate permission before redistribution or public deployment.

Room settings and sessions survive restarts; interrupted matches return to the lobby. Scoring penalties and tie-breaking are independent policies, and physics results are client-reported. Upstream changes can require a compatibility update. See [architecture and operation](docs/architecture.md) for details.

# Installation

This guide takes a fresh clone to a running party, and states what each step
requires. Everything here was run against a clean `git archive` of the repository
with no `node_modules`, no `web/` and no `state/`.

## What you need

| Tool                   | Version used | Needed for                                     |
| ---------------------- | ------------ | ---------------------------------------------- |
| [Bun](https://bun.sh/) | 1.4.2        | Running the service and the tests              |
| Python 3               | 3.9 or later | Verifying and building the archived client     |
| Node.js                | 22 or later  | Development tooling only (the pre-commit hook) |
| Curl                   | any          | Browser integration tests only                 |
| ShellCheck             | any          | The lint step                                  |

**Bun 1.4.2** is the version this was built and tested against, pinned in
`Dockerfile` and in `.github/workflows/ci.yml`. The package has **no `engines`
field**, so an older Bun will not refuse to run; it will simply be untested. One
concrete reason not to drift far: the service transpiles the TypeScript client
scripts with `Bun.Transpiler` at request time, so the Bun version is part of the
runtime, not just the toolchain.

**Python 3.9 or later.** All four scripts under `scripts/` parse as Python 3.9,
which matches the `target-version = "py39"` in `pyproject.toml`. CI uses 3.12.
No third-party Python packages are needed to prepare the client; `ruff` from
`requirements-dev.txt` is only needed for linting.

**Node.js is not needed to run the service.** It is needed by `lint-staged`,
which the pre-commit hook invokes, and its shebang is `#!/usr/bin/env node`. Skip
the hook and you can skip Node entirely.

## Install

```sh
git clone <repository> putt-better-party
cd putt-better-party

bun install --frozen-lockfile
bun run hooks:install
bun run prepare:client
bun run start
```

Then open **<http://localhost:8789>**.

`127.0.0.1` works as well, because the default configuration answers both
spellings of loopback; neither is a special case you have to configure. Binding
is loopback-only by default, so nothing on your network can reach it until you
set `BP_HOST` or put a proxy in front.

### What each step is for

`bun install --frozen-lockfile` installs **development tooling only**. The
service has no runtime dependencies at all: every import is either relative or a
`bun:`/`node:` builtin, so the server runs with no `node_modules` present. That
is how the container image is built, and it is verified in
[operations](operations.md#running-in-a-container).
`--frozen-lockfile` fails rather than silently resolving a different version, so
a lockfile that drifted is a visible error instead of a surprise.

`bun run hooks:install` runs `git config --local core.hooksPath .githooks`, which
is the only thing the repository stores: the hook itself lives in
`.githooks/pre-commit` and is committed, but Git does not use it until the
hooks path points there. The hook formats and lints staged files, then runs the
client preparation, the type checker and the unit tests. Skip this step and
nothing breaks — you just find out about a failure when CI does.

`bun run prepare:client` builds the client. It is **entirely offline** and is not
optional: the service will not start without its output.

### The assets are required, and already in the clone

The prepared client is derived from the original game client. The archived
originals live in `private-client/` — 275 files, tracked in Git, so a clone has
them even though `.gitignore` lists the directory. `scripts/client-lock.json`
pins every one of them by SHA-256.

Preparation verifies the whole snapshot before writing anything:

```
Verified all 275 archived asset hashes
Cross-checked 158 runtime asset references against the lock
Patched isolated browser bootstrap, local join, local catalog, original validation; Party transport, scene readiness, and initial ball placement patched; shot physics unchanged.
Syntax-checked 5 patched bundle(s) before publishing
```

The second line is the one worth understanding. The lock proves what is archived
is intact but says nothing about whether the bundles ask for something the lock
does not carry, so preparation reverses the references the client builds at
runtime and requires each to be pinned. A missing course piece, prop, skybox,
sound or texture fails the build instead of appearing as a missing model in a
live round.

The result is a `web/` directory of about 23 MB containing the patched client,
its assets and a generated `web/validation/` directory. That last one matters:
the server's upstream adapter imports the original spec validator from it, so a
client prepared by an older version of this project — or copied from one — may
lack it.

Failure modes are deliberate and name the problem:

| Situation                       | Result                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Archived file edited or missing | `Archived asset hash mismatch: /assets/date-D4dx3Sc1.js; restore it from Git`         |
| `web/` absent or stale          | Startup fails: `Cannot find module '../../web/validation/specValidation-vqop-JBL.js'` |
| Unlisted local file added       | Not included in the prepared client                                                   |

Nothing is downloaded in any case, and no newer upstream release is silently
substituted for the reviewed snapshot.

### First run

`bun run start` creates `state/` on first use with mode `0700`, and writes
`state/rooms.sqlite` with mode `0600`. Room credentials live in that database, so
keep it private and keep it out of Git — `.gitignore` already covers `state/`,
`*.sqlite` and the write-ahead log.

## Verify the installation

```sh
curl -s http://127.0.0.1:8789/health
```

A healthy service answers with `"ok": true`. If you would rather check the page,
note that a `200` on `/` alone is not sufficient evidence: the client scripts are
transpiled on request, so fetch one of them too.

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8789/assets/bp-home.js
```

## Development checks

```sh
python3 -m pip install -r requirements-dev.txt   # pinned ruff
bun run format
bun run lint
bun run check
```

`bun run check` runs client preparation, formatting, linting (ESLint, Ruff,
ShellCheck), strict TypeScript checking and the unit tests. It is the same check
CI runs.

See the [development guide](development.md) for the integration and browser
suites, and the [operations guide](operations.md) for configuration, deployment,
backups and containers.

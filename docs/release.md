# Releasing

A release of this project is **source only**. That single constraint shapes
everything below, because the archived original game client is tracked in Git and
a naive `git archive` would put it in every artefact.

## Why the client is excluded

`private-client/` holds 275 files: the original game client's bundles, models,
textures, sounds and icons, each pinned by SHA-256 in `scripts/client-lock.json`.
They are archived here for private development and are **not** licensed by this
project.

Because Git tracks them, `git archive HEAD` includes them. The count of entries
under that prefix is not zero:

```
$ git archive HEAD | tar -t | grep -c '^private-client/'
287
```

That is 275 files plus 12 directory entries — a redistribution of material this
project has no permission to publish. A release therefore has to exclude them
deliberately, and then prove it did.

## Building a release

```sh
bun run release:check
bun run release:archive --output dist/putt-better-party-1.0.0.tar.gz
python3 scripts/release.py verify dist/putt-better-party-1.0.0.tar.gz
```

`release:check` does three things: it confirms the version metadata agrees with
itself, builds an archive of `HEAD`, and inspects that archive for proprietary
members. It is the command to run before tagging.

`release:archive` repeats those checks and writes the file. `verify` checks an
existing artefact, which is the useful command when someone hands you a tarball.

### What the checks enforce

| Check               | Refuses when                                                |
| ------------------- | ----------------------------------------------------------- |
| Version in manifest | `package.json` has no string `version` at `HEAD`            |
| Changelog agreement | There is no `## [<version>]` heading                        |
| Changelog order     | The newest released heading is not the current version      |
| Tag match           | `--tag v1.2.3` disagrees with the manifest                  |
| Clean metadata      | `package.json` or `CHANGELOG.md` differs from `HEAD`        |
| Source only         | Any member is under `private-client/` or `web/`             |
| Source only         | Any member's basename appears in `scripts/client-lock.json` |

The last row is not redundant. Checking only the directory prefix would let a
relocated original through, so the lock is consulted by basename as well. Both
cases were verified to exit `1` with the offending path named.

### Why metadata is read from the commit

This started as a defect. The first version read `package.json` from the working
tree while `git archive` built from `HEAD`, so an uncommitted bump to `1.0.1`
passed the check while the artefact shipped `1.0.0`:

```
$ python3 scripts/release.py check          # working tree says 1.0.1
ok: version 1.0.1 matches CHANGELOG.md
$ tar -xzOf archive.tar.gz package.json | ...
archive version: 1.0.0
```

A release describes a commit. Metadata is now read with `git show HEAD:...`, and
a modified `package.json` or `CHANGELOG.md` is refused with the reason, because
otherwise the commit you tested is not the commit you are shipping.

## Reproducibility

`git archive` of a fixed commit is byte-identical for a fixed pathspec. Measured
across repeat runs and across working directories — the same `sha256` both times.

Both the release workflow and the test suite rebuild the archive and compare
hashes, rather than asserting reproducibility in prose. This page deliberately
does not quote a hash or an entry count: both change with every commit, and a
number copied into documentation is wrong the moment anyone commits. Run
`bun run release:check` to see the current values.

Two things are deliberately _not_ claimed. The archive is reproducible for a
given commit and a given `git` implementation; nothing here pins the gzip
implementation, so a different `git` could produce different bytes. And the
**prepared client** is not reproducible in the same sense — it is generated from
the archive by `prepare:client`, which is deterministic in its inputs but is
rebuilt rather than shipped.

## The archive cannot be installed on its own

This is the honest consequence of excluding the client, and it is worth stating
plainly rather than discovering after a download:

```sh
$ tar -xzf putt-better-party-1.0.0.tar.gz -C unpacked
$ cd unpacked && python3 scripts/prepare-client.py
Missing archived asset: /assets/-admin.schedule-calendar-D0WXblcm.js; restore it from Git
$ echo $?
1
```

A source-only archive is **source**, not an installer. It carries the service, the
patcher, the lock and the tests, but not the originals those depend on. To run it
you need the full repository — which is what [installation](installation.md)
describes.

CI asserts this failure on purpose, so the boundary cannot drift: if the archive
ever started carrying the client, preview preparation would succeed and the check
would fail instead of silently publishing a redistribution.

## Versioning

Version assignment is described in [CHANGELOG.md](../CHANGELOG.md). The short
version, because it matters when cutting a release:

- The **service** version lives in `package.json` and is reported at `/health`.
- The **protocol** version (`2`) is separate and changes only when a frame changes
  shape incompatibly.
- The **checkpoint** version (`1`) is separate and changes only when the stored
  room format breaks.

A patch release touches neither of the latter. A minor release may add frames or
settings while old clients and old checkpoints still work. A major release may
require a new client or refuse an older checkpoint, and says so in its entry.

## Cutting a release

```sh
# 1. Bump the version and add the changelog entry, then COMMIT both.
#    An uncommitted bump is refused, because the archive is built from HEAD.

# 2. Verify.
bun run release:check --tag v1.0.0

# 3. Build and confirm the artefact.
bun run release:archive --output dist/putt-better-party-1.0.0.tar.gz --tag v1.0.0
python3 scripts/release.py verify dist/putt-better-party-1.0.0.tar.gz

# 4. Tag the commit the archive was built from.
git tag v1.0.0
git push origin main --tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which repeats every check
on a clean checkout, rebuilds to compare hashes, confirms the unpacked archive
cannot prepare a client, and uploads the tarball as a workflow artefact. It
**publishes nothing publicly** — releases of this repository are private, for the
same reason the repository is.

`bun run release:check` also runs on every push and pull request in `ci.yml`,
because a version mismatch found at release time has already been merged.

## What a release does not contain

- **The original client or any game asset.** The reason this page exists.
- **A prepared `web/` build.** It is generated, and `prepare:client` rebuilds it.
- **A database, log, recording or credential.** `.gitignore` covers these, and the
  archive is built from committed content, so an untracked file cannot leak in.

## Related

- [Installation](installation.md) for what is needed to actually run a release.
- [Upgrading](upgrading.md) for what survives a version change, and rollback.
- [Configuration](configuration.md) for the settings a deployment needs.

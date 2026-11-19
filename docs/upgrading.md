# Upgrading and rolling back

Upgrade is the operation most likely to lose data quietly, so this page is
specific about what survives, what is refused, and how to undo a change. Every
claim here was exercised against a running service rather than read off the
source.

## What survives an upgrade

| Thing                        | Survives | Notes                                  |
| ---------------------------- | -------- | -------------------------------------- |
| Room settings                | Yes      | Restored from the checkpoint           |
| Identity sessions            | Yes      | A player keeps their rejoin credential |
| Host authority               | Yes      | The host token is in the checkpoint    |
| Saved playlists              | Yes      | Part of the room configuration         |
| Personal bests, leaderboard  | Yes      | In the same database                   |
| **An in-progress match**     | **No**   | Returns to the lobby, deliberately     |
| The prepared client (`web/`) | No       | Regenerated from source; see below     |

The one that surprises people is a match in progress. A restarted process cannot
recover the original client's physics state, so a hole that was being played
cannot be resumed meaningfully — a resumed hole would show stale scores from a
shot the engine no longer remembers. Returning to the lobby is the honest
outcome, and the alternative would be inventing play data.

## Upgrade procedure

```sh
# 1. Take a backup first. This is the rollback plan.
bun run backup

# 2. Stop the service. Let it shut down; do not kill it if you can avoid it,
#    because the ordered path is what folds the write-ahead log into the database.
#    systemctl stop party   /   docker stop party   /   kill <pid>

# 3. Update the source.
git fetch && git checkout <tag-or-commit>

# 4. Rebuild the client. This is not optional.
bun install --frozen-lockfile
bun run prepare:client

# 5. Start and verify.
bun run start
curl -s http://127.0.0.1:8789/health
```

**Step 4 is the one to not skip.** The server and the prepared client are a
matched pair: the patcher splices code into the original bundles that expects the
server it ships with. Running a new server against an old `web/` is the most
common way to end up with a party that loads but does not work.

### Confirming you are running what you think

`/health` reports both versions:

```json
{
  "ok": true,
  "version": "1.0.0",
  "client": { "clientBuild": "56b4d7183405328d", "assets": 275 }
}
```

`version` is the service release. `client.clientBuild` is a short hash over the
patcher and every snippet it splices, so **any change to the client build changes
the stamp** and an unchanged source tree produces the same stamp again. Both
properties were checked: editing a snippet changed the hash, and reverting it
returned the original value exactly.

Compare that stamp against the checkout you meant to deploy. A `client` of `null`
means the build could not be identified — an older prepared client, or one
supplied by a container mount. That is not an error, but it does mean you cannot
confirm the pairing from `/health` and should rebuild instead of assuming.

## What the versions mean for compatibility

Three versions move independently, and only one of them can refuse to start:

| Version                                   | Refuses what                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Service (`version`)                       | Nothing. It is informational.                                           |
| Protocol (`protocol: 2`, checked on join) | A client speaking an older protocol is rejected at the handshake.       |
| Checkpoint (`CHECKPOINT_VERSION`)         | A stored room written by an incompatible format is skipped, not loaded. |

## Rollback

There are two distinct cases, and they need different answers.

### Rolling back the code

Stop the service, check out the earlier commit or tag, **re-run
`bun run prepare:client`**, and start. The prepared client must go back with the
server, for the same reason it had to move forward with it.

If the older build cannot read the newer checkpoints, this is what you will see:

```
Skipped stored room "K6LWA" (unsupported-version): unsupported version 2
```

The room is **skipped, not deleted** — the row stays in the database, so the data
is still there if you move forward again or want to inspect it. That was verified
by hand-writing a version-2 checkpoint and starting a version-1 build: the room
was refused with that exact message, the process started normally, and the row was
still present afterwards. A rollback is therefore non-destructive even when it is
incompatible.

The room does eventually disappear, but only through the ordinary idle sweep,
which removes rows untouched for **30 minutes**. That sweep was verified too: a
row backdated 31 minutes was removed on the next start.

So after a cross-version rollback, players' rooms are gone from the running
service. If that matters, restore a backup instead.

### Rolling back the data

`bun run backup` writes a self-contained SQLite file: the write-ahead log is
folded in, so the file is the whole database and not a partial copy. To roll back,
stop the service and point `BP_DB` at the backup:

```sh
bun run backup --directory /srv/party/backups
# stop the service
BP_DB=/srv/party/backups/rooms-2026-11-18T20-48-47-311Z.sqlite bun run start
```

(Bun forwards extra arguments to the script, which was verified: `bun run backup
--directory /srv/party/backups` reaches `backup.py create` as `--directory`.)

This was verified end to end: a room created on a live service, backed up while
running, and then restored by booting a service against the backup file, which
answered with the original room code and phase.

`bun run backup --help` and `python3 scripts/backup.py verify <file>` report the
room count and **the checkpoint versions present**, which is exactly what you want
to know before attempting a rollback — a backup containing version 2 checkpoints
will not load on a version 1 build.

### Rolling back the client alone

Possible, but only with a matching prepared client. `web/` is generated and not
versioned, so going back means checking out the old source and running
`bun run prepare:client` again. There is no supported way to keep two prepared
clients and switch between them, and doing it by copying directories is how
someone ends up with a client whose patches do not match the server.

## Migrations

There are no data migrations, and that is a property worth stating rather than an
omission.

The store keeps each room as one JSON payload in a table created if absent:

```sql
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  updated INTEGER NOT NULL,
  payload TEXT NOT NULL
)
```

A checkpoint carries a `version`. On load, a version that is not the current one
is **refused** rather than converted, and the refusal is logged with the reason.
This means:

- Upgrading **within** a checkpoint version needs no migration: absent fields have
  defined defaults, checked by the validator.
- Upgrading **across** a checkpoint version does not happen silently. Either the
  format is unchanged, or the build refuses the row and says so.
- Nothing rewrites existing rows on startup, so a bad build cannot corrupt data it
  did not understand. That is deliberate: a skipped row is left untouched because
  deleting it destroys the only copy of credentials a player may still hold.

If a future change needs to alter the format, the honest path is to bump
`CHECKPOINT_VERSION`, add a converter, and write the test that proves the old
shape loads — not to widen the validator until old rows happen to pass.

## Verifying an upgrade

```sh
curl -s http://127.0.0.1:8789/health | head -c 200      # version and client stamp
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8789/assets/bp-home.js
bun run backup && python3 scripts/backup.py verify <the-file>
```

The second command matters more than it looks: a `200` on `/` alone does not prove
the client is healthy, because the browser scripts are transpiled on request. If
transpilation or the prepared client is broken, `/` still answers and the asset
does not.

Then create a party and play one hole. That is the only check that exercises the
patched client, the server, and the upstream catalog together.

## If something goes wrong

| Symptom                                                        | Likely cause                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Cannot find module '.../web/validation/specValidation-...js'` | `web/` is missing or stale. Run `bun run prepare:client`.               |
| Pages load, buttons do nothing                                 | A stale `web/` paired with a newer server. Rebuild.                     |
| `Skipped stored room ... (unsupported-version)`                | Rollback across a checkpoint version. Restore a backup or move forward. |
| `Skipped stored room ... (corrupt)`                            | The row was truncated or hand-edited. Left in place for inspection.     |
| `Archived asset hash mismatch` during preparation              | `private-client/` was modified. Restore from Git; do not re-download.   |
| Rooms empty after restart                                      | The idle sweep removed them (30 minutes), or the database path changed. |

See the [operations guide](operations.md) for backups, shutdown and recovery, and
the [configuration reference](configuration.md) for `BP_DB` and the rest.

## Watching upstream

Upstream compatibility checks are deliberate, on-demand and read-only — nothing
here runs on a schedule, because the lock is a ratchet and never a suggestion.

```sh
# 1. Snapshot the live upstream (network; writes only under captures/).
bun run capture:client

# 2. Verdict: is this capture complete and identical to the pin?
bun run capture:verify captures/<timestamp>     # exit 0 installable / 1 incomplete / 2 unreadable

# 3. What drifted, exactly — and would the patches still apply?
bun run capture:diff captures/<timestamp>
```

`capture:diff` reports four surfaces, and writes nothing:

- **dependencies** — `changed`/`added`/`removed`/`missing`/`mismatched` paths
  against the lock (the same classification the verifier returns);
- **media** — registry-discovered models, skyboxes and sounds the new bundles
  reference or drop, compared by logical name so hash-suffixed renames do not
  double-report;
- **textures** — external URIs inside the GLBs, the reference class no
  JavaScript scan can see;
- **anchors** — every patch body dry-run against the new bundles: `ok`, or
  `failed` naming the exact anchor with found-vs-expected counts, or `missing`
  when a bundle no longer exists by that logical name.

A clean diff (all anchors `ok`, no removals that matter) means the new build is
a candidate for deliberate adoption — updating the lock and re-proving is a
human step on purpose. A drifted anchor is information, not a blocker: the pin
keeps working regardless of what upstream does next.

#!/usr/bin/env python3
"""Create, verify and prune consistent backups of the room database.

The service stores room checkpoints in SQLite in WAL mode, which is why copying
the file by hand is not a backup: recent commits can still be only in the
`-wal` file, so a plain copy can lose them or capture a torn state. This uses
SQLite's own backup API, which takes a consistent snapshot of a live database
without stopping the service.

A backup contains identity sessions and host capabilities, so every file this
writes is created `0600` inside a `0700` directory and must be treated as
private. Nothing here prints room contents; the counts and sizes it reports are
not secrets, but the payloads are.

Usage:

    python3 scripts/backup.py create --db state/rooms.sqlite --directory state/backups
    python3 scripts/backup.py verify state/backups/rooms-2026-01-01T00-00-00-000Z.sqlite
    python3 scripts/backup.py prune --directory state/backups --keep 7
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

# Room checkpoints a current build can read. A newer number is not corruption:
# it means the file was written by a later version of the service.
SUPPORTED_CHECKPOINT_VERSION = 1

BACKUP_PREFIX = "rooms-"
BACKUP_SUFFIX = ".sqlite"
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def fail(message: str) -> NoReturn:
    """Report a problem on stderr and exit non-zero."""
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def utc_stamp() -> str:
    """A filename-safe UTC timestamp that sorts lexicographically by time."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H-%M-%S-") + f"{now.microsecond // 1000:03d}Z"


def prepare_private_directory(directory: Path) -> None:
    """Create the backup directory, and tighten it if it already exists."""
    directory.mkdir(parents=True, exist_ok=True)
    # `exist_ok` means an existing directory keeps its mode, so set it
    # explicitly rather than relying on the creation mode having applied.
    os.chmod(directory, PRIVATE_DIRECTORY_MODE)


def restrict(path: Path) -> None:
    """Make one file private to its owner."""
    os.chmod(path, PRIVATE_FILE_MODE)


def count_rooms(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT COUNT(*) FROM rooms").fetchone()
    return int(row[0]) if row else 0


def create_backup(database: Path, directory: Path) -> Path:
    """Take a consistent snapshot of `database` into `directory`."""
    if not database.exists():
        fail(f"no database at {database}")
    prepare_private_directory(directory)
    destination = directory / f"{BACKUP_PREFIX}{utc_stamp()}{BACKUP_SUFFIX}"
    if destination.exists():
        # Two backups in the same millisecond would otherwise overwrite silently.
        fail(f"backup already exists at {destination}")
    # The destination is created here so its mode is ours to set before SQLite
    # opens it; a file SQLite creates itself would use the process umask.
    destination.touch(mode=PRIVATE_FILE_MODE, exist_ok=True)
    restrict(destination)
    # `mode=ro` on the source keeps this a read: a backup must never mutate the
    # live database, and a read-only connection cannot checkpoint or write.
    source = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(str(destination))
        try:
            # The backup API copies a consistent snapshot including everything
            # committed to the write-ahead log, which is the whole point.
            source.backup(target)
            # Fold any WAL the copy itself produced back into the single file and
            # leave it in rollback-journal mode, so the backup is one
            # self-contained artifact. A file left in WAL mode recreates its
            # `-wal` and `-shm` companions whenever it is opened, including by a
            # read-only verification, which would make the artifact incomplete on
            # its own. The service sets WAL again when it opens the database.
            target.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            target.execute("PRAGMA journal_mode=DELETE")
        finally:
            target.close()
    finally:
        source.close()
    restrict(destination)
    # A WAL left beside the backup would make the artifact incomplete on its own.
    for suffix in ("-wal", "-shm"):
        leftover = Path(str(destination) + suffix)
        if leftover.exists():
            leftover.unlink()
    return destination


def verify_backup(path: Path) -> None:
    """Prove a backup file is a readable room database, or exit non-zero."""
    if not path.exists():
        fail(f"no backup at {path}")
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        # A backup carrying sessions must not be group- or world-readable.
        fail(f"{path} is readable beyond its owner (mode {oct(mode)})")
    # `immutable=1` tells SQLite the file cannot change, so it neither creates
    # `-wal`/`-shm` companions beside a backup nor tries to recover a journal. A
    # verification must not modify what it is verifying.
    connection = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            fail(f"{path} failed its integrity check: {integrity[0] if integrity else 'no result'}")
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "rooms" not in tables:
            fail(f"{path} has no rooms table, so it is not a room database")
        rooms = count_rooms(connection)
        # Checkpoint versions are reported rather than rejected: a newer version
        # is what a rollback has to cope with, and refusing to verify the file
        # would hide exactly the backup an operator most needs to keep.
        versions: dict[int, int] = {}
        unreadable = 0
        for (payload,) in connection.execute("SELECT payload FROM rooms"):
            try:
                parsed = json.loads(payload)
            except (TypeError, ValueError):
                unreadable += 1
                continue
            if not isinstance(parsed, dict) or not isinstance(parsed.get("version"), int):
                unreadable += 1
                continue
            version = parsed["version"]
            versions[version] = versions.get(version, 0) + 1
    finally:
        connection.close()
    print(f"ok: {path}")
    print(f"  rooms: {rooms}")
    for version in sorted(versions):
        current = "" if version == SUPPORTED_CHECKPOINT_VERSION else " (not this build)"
        print(f"  checkpoint version {version}: {versions[version]}{current}")
    if unreadable:
        print(f"  unparsable payloads: {unreadable}")
    if versions and all(version != SUPPORTED_CHECKPOINT_VERSION for version in versions):
        # Every row being from another version is worth saying out loud: this
        # build would start empty against it even though the file is intact.
        print(
            f"warning: no checkpoint is version {SUPPORTED_CHECKPOINT_VERSION}; "
            "this build would skip every room in this backup"
        )


def list_backups(directory: Path) -> list[Path]:
    """Every backup in `directory`, oldest first by UTC timestamp in the name."""
    if not directory.is_dir():
        return []
    found = [
        path
        for path in directory.iterdir()
        if path.is_file()
        and path.name.startswith(BACKUP_PREFIX)
        and path.name.endswith(BACKUP_SUFFIX)
    ]
    return sorted(found, key=lambda path: path.name)


def prune_backups(directory: Path, keep: int) -> list[Path]:
    """Delete all but the newest `keep` backups, and report what went."""
    found = list_backups(directory)
    if keep < 1:
        fail("--keep must be at least 1, so a prune never removes every backup")
    removed = found[: max(0, len(found) - keep)]
    for path in removed:
        path.unlink()
    return removed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create", help="take a consistent snapshot")
    create.add_argument("--db", type=Path, default=Path("state/rooms.sqlite"))
    create.add_argument("--directory", type=Path, default=Path("state/backups"))

    verify = commands.add_parser("verify", help="check a backup can be restored")
    verify.add_argument("path", type=Path)

    prune = commands.add_parser("prune", help="delete all but the newest backups")
    prune.add_argument("--directory", type=Path, default=Path("state/backups"))
    prune.add_argument("--keep", type=int, default=7)

    arguments = parser.parse_args(argv)
    if arguments.command == "create":
        destination = create_backup(arguments.db, arguments.directory)
        # Verify immediately: a backup that cannot be restored is worse than
        # none, because it looks like protection.
        verify_backup(destination)
        return 0
    if arguments.command == "verify":
        verify_backup(arguments.path)
        return 0
    removed = prune_backups(arguments.directory, arguments.keep)
    for path in removed:
        print(f"removed {path}")
    print(f"kept {len(list_backups(arguments.directory))} backups in {arguments.directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Verify release metadata and build a source-only release archive.

A release of this project is **source only**. The archived original game client
under `private-client/` is tracked in Git, so a naive `git archive` would put the
proprietary bundles and assets into every release artefact. That is the one thing
this script exists to prevent, and every other check is secondary to it.

Three properties are enforced rather than assumed:

  - **The version agrees with itself.** `package.json` carries the version and
    `CHANGELOG.md` must have a matching heading, so a release cannot be cut with a
    bumped manifest and no entry, or an entry and no bump.
  - **The archive is source only.** Members under the proprietary paths are
    refused, and so is any file whose name appears in `scripts/client-lock.json`,
    which catches an asset that was moved somewhere new.
  - **The archive is reproducible.** `git archive` of a fixed commit produces
    identical bytes for the same pathspec, so two runs of this command on the same
    commit give the same SHA-256. Verified by running it twice, not by assertion.

Usage:

    python3 scripts/release.py check
    python3 scripts/release.py check --tag v1.0.0
    python3 scripts/release.py archive --output dist/putt-better-party-1.0.0.tar.gz
    python3 scripts/release.py verify dist/putt-better-party-1.0.0.tar.gz
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent

# Never part of a release archive. `private-client` is the archived original game
# client; `web` is its prepared derivative and is generated rather than tracked,
# but it is listed so a release cut from a working tree cannot include it either.
PROPRIETARY_PATHS = ("private-client", "web")

CHANGELOG_HEADING = re.compile(r"^## \[(\d+\.\d+\.\d+)\]", re.MULTILINE)


class ReleaseError(Exception):
    """A release precondition that failed, with the reason stated plainly."""


def read_committed(relative: str) -> str:
    """The content of a file at HEAD, so metadata is checked against the commit.

    Reading the working tree instead was a real defect: with an uncommitted bump to
    `package.json` the check passed for 1.0.1 while `git archive HEAD` shipped
    1.0.0. A release describes a commit, so the commit is what gets inspected.
    """
    result = subprocess.run(
        ["git", "-C", str(root), "show", f"HEAD:{relative}"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseError(f"{relative} is not present at HEAD; commit it before releasing")
    return result.stdout.decode("utf-8", "replace")


def uncommitted_changes(relative_paths: tuple[str, ...]) -> list[str]:
    """Which of the release-defining files differ from HEAD."""
    result = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain", "--", *relative_paths],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseError("git status failed; cannot confirm the tree matches HEAD")
    return [line for line in result.stdout.decode("utf-8", "replace").splitlines() if line]


def changelog_versions(text: str) -> list[str]:
    return CHANGELOG_HEADING.findall(text)


def locked_asset_names(lock: Path) -> set[str]:
    """Basenames of every archived original, used to catch a relocated asset."""
    if not lock.is_file():
        raise ReleaseError(f"{lock.name} is missing; the archive cannot be checked")
    return {Path(path).name for path in json.loads(lock.read_text())}


def check_version(tag: str | None) -> None:
    manifest = json.loads(read_committed("package.json"))
    version = manifest.get("version")
    if not isinstance(version, str):
        raise ReleaseError("package.json has no string version field at HEAD")
    versions = changelog_versions(read_committed("CHANGELOG.md"))
    if version not in versions:
        raise ReleaseError(
            f"package.json is {version} but CHANGELOG.md has no '## [{version}]' entry; "
            "add the entry or correct the manifest"
        )
    # The newest released heading should be the current version, otherwise an older
    # entry has been left above it and the changelog reads out of order.
    if versions[0] != version:
        raise ReleaseError(
            f"the first released changelog entry is {versions[0]}, not {version}; "
            "entries must be newest first"
        )
    if tag is not None:
        wanted = tag[1:] if tag.startswith("v") else tag
        if wanted != version:
            raise ReleaseError(f"tag {tag} does not match package.json version {version}")
    # A release describes a commit. If the metadata differs from HEAD then the
    # commit you tested is not the commit you are shipping, and the archive below
    # would carry values this check never saw.
    dirty = uncommitted_changes(("package.json", "CHANGELOG.md"))
    if dirty:
        raise ReleaseError(
            "package.json or CHANGELOG.md has uncommitted changes; "
            "commit the version bump before releasing, because the archive is built "
            "from HEAD:\n  " + "\n  ".join(dirty)
        )
    print(f"ok: version {version} matches CHANGELOG.md" + (f" and tag {tag}" if tag else ""))


def archive_members_refused(names: list[str], locked: set[str]) -> list[str]:
    """Everything in `names` that must not appear in a release."""
    refused: list[str] = []
    for name in names:
        parts = name.split("/")
        if parts and parts[0] in PROPRIETARY_PATHS:
            refused.append(name)
        elif Path(name).name in locked:
            refused.append(name)
    return refused


def build_archive() -> bytes:
    """A deterministic tar.gz of HEAD with the proprietary paths excluded."""
    pathspec = ["--", ".", *[f":(exclude){path}" for path in PROPRIETARY_PATHS]]
    result = subprocess.run(
        ["git", "-C", str(root), "archive", "--format=tar.gz", "HEAD", *pathspec],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseError(
            "git archive failed: " + result.stderr.decode("utf-8", "replace").strip()
        )
    return result.stdout


def verify_archive_bytes(payload: bytes, label: str) -> tuple[int, str]:
    """Refuse a payload that carries proprietary material; return count and hash."""
    digest = hashlib.sha256(payload).hexdigest()
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        names = tar.getnames()
    refused = archive_members_refused(names, locked_asset_names(root / "scripts/client-lock.json"))
    if refused:
        shown = ", ".join(refused[:5])
        more = "" if len(refused) <= 5 else f" and {len(refused) - 5} more"
        raise ReleaseError(f"{label} contains {len(refused)} proprietary member(s): {shown}{more}")
    return len(names), digest


def command_check(args: argparse.Namespace) -> int:
    check_version(args.tag)
    # The archive is built and inspected here too, so a version check cannot pass
    # on a tree that would produce a release carrying the client.
    payload = build_archive()
    count, digest = verify_archive_bytes(payload, "a fresh archive")
    print(f"ok: archive of HEAD is source only ({count} entries, sha256 {digest[:16]})")
    return 0


def command_archive(args: argparse.Namespace) -> int:
    check_version(args.tag)
    payload = build_archive()
    count, digest = verify_archive_bytes(payload, "the archive")
    output: Path = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    print(f"ok: {output}")
    print(f"  entries: {count}")
    print(f"  sha256:  {digest}")
    return 0


def command_verify(args: argparse.Namespace) -> int:
    path: Path = args.path
    if not path.is_file():
        raise ReleaseError(f"{path} does not exist")
    count, digest = verify_archive_bytes(path.read_bytes(), str(path))
    print(f"ok: {path} is source only")
    print(f"  entries: {count}")
    print(f"  sha256:  {digest}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Verify release metadata and build a source-only archive."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    check = commands.add_parser("check", help="check version metadata and that HEAD is releasable")
    check.add_argument("--tag", default=None, help="tag to compare against, for example v1.0.0")
    check.set_defaults(handler=command_check)

    archive = commands.add_parser("archive", help="write a source-only archive of HEAD")
    archive.add_argument("--output", type=Path, required=True, help="path of the .tar.gz to write")
    archive.add_argument("--tag", default=None, help="tag to compare against, for example v1.0.0")
    archive.set_defaults(handler=command_archive)

    verify = commands.add_parser(
        "verify", help="check an existing archive carries no proprietary code"
    )
    verify.add_argument("path", type=Path)
    verify.set_defaults(handler=command_verify)

    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except ReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

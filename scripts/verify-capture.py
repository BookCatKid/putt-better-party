#!/usr/bin/env python3
"""Evaluate a staged client capture against the pinned client lock.

Usage: python3 scripts/verify-capture.py captures/<snapshot>

Prints a JSON verdict to stdout and exits:

  0 - the capture is complete: every captured file hashed as its manifest
      claims, the manifest parses, and no fetch is recorded missing. Changed
      and added paths are reported, not failures - they are what a lock
      update exists to adopt.
  1 - the capture is incomplete or contradicts itself: fetch failures are
      recorded, captured bytes do not match their manifest hashes, or the
      manifest lacks fields the verdict depends on.
  2 - the capture could not be read at all: no directory, or no parseable
      manifest. Nothing else is checked.

Whatever the outcome the capture directory is left untouched: a failed or
partial capture is itself the diagnostic, so it is preserved rather than
cleaned up.
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = ROOT / "scripts" / "client-lock.json"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fail(exit_code, **verdict):
    print(json.dumps(verdict, indent=2, sort_keys=True))
    raise SystemExit(exit_code)


def main():
    lock_path = LOCK
    argv = sys.argv[1:]
    # A different lock is a legitimate comparison - a release's pinned set
    # against a new capture - and is how the verdict logic gets exercised
    # without the repository's real 275-entry lock.
    if len(argv) >= 2 and argv[0] == "--lock":
        lock_path = pathlib.Path(argv[1]).resolve()
        argv = argv[2:]
    if len(argv) != 1:
        print(__doc__.strip())
        raise SystemExit(2)
    capture = pathlib.Path(argv[0]).resolve()
    if not capture.is_dir():
        fail(2, ok=False, reason="no-such-capture", capture=str(capture))
    manifest_path = capture / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        fail(2, ok=False, reason="unreadable-manifest", detail=str(error))
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        fail(2, ok=False, reason="manifest-missing-assets")

    lock = json.loads(lock_path.read_text())
    verdict = classify_capture(capture, manifest, lock)
    fail(0 if verdict["ok"] else 1, **verdict)


def classify_capture(capture, manifest, lock):
    """
    Reconcile one capture directory with a lock manifest.

    Shared with `diff-capture.py`, which reports the same classification as part
    of a wider diff. Returns the verdict object; callers decide the exit code.
    """
    assets = manifest.get("assets") or {}
    captured = {}
    mismatched = []
    for path, record in assets.items():
        target = capture / path.lstrip("/")
        expected = record.get("sha256") if isinstance(record, dict) else None
        if not target.is_file():
            mismatched.append({"path": path, "problem": "manifest-without-file"})
            continue
        digest = sha256(target.read_bytes())
        if expected and digest != expected:
            mismatched.append({"path": path, "problem": "hash-mismatch"})
            continue
        captured[path] = digest

    unchanged, changed, removed, added = [], [], [], []
    for path, digest in sorted(lock.items()):
        if path not in captured:
            # Absent from the capture and not declared missing means upstream
            # no longer serves it - a real removal, not a capture failure.
            if path not in (manifest.get("missing") or {}):
                removed.append(path)
        elif captured[path] == digest:
            unchanged.append(path)
        else:
            changed.append({"path": path, "old": digest, "new": captured[path]})
    for path in sorted(captured):
        if path not in lock:
            added.append(path)

    missing = manifest.get("missing") or {}
    complete = not missing and not mismatched
    return {
        "ok": complete,
        "capture": str(capture),
        "entry": manifest.get("entry"),
        "counts": {
            "captured": len(captured),
            "unchanged": len(unchanged),
            "changed": len(changed),
            "added": len(added),
            "removed": len(removed),
            "missing": len(missing),
            "mismatched": len(mismatched),
        },
        "changed": changed,
        "added": added,
        "removed": removed,
        "missing": missing,
        "mismatched": mismatched,
    }


if __name__ == "__main__":
    main()

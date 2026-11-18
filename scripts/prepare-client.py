#!/usr/bin/env python3
"""Verify and build the archived client without accessing the network."""

import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
private = root / "private-client"
web = root / "web"
hashes = json.loads((root / "scripts/client-lock.json").read_text())

# Verify the entire snapshot before touching generated output. The lock is the
# single list of original files; no missing file may be fetched from a newer
# release, and unlisted local files must not enter the prepared client.
for path, expected in hashes.items():
    relative = pathlib.PurePosixPath(path)
    if not relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"Invalid archived asset path: {path}")
    source = private / path.lstrip("/")
    if not source.is_file():
        raise SystemExit(f"Missing archived asset: {path}; restore it from Git")
    actual = hashlib.sha256(source.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"Archived asset hash mismatch: {path}; restore it from Git")

print(f"Verified all {len(hashes)} archived asset hashes", flush=True)

# Replace only generated output, never the archived originals.
for generated in (web, private / "validation"):
    if generated.exists():
        shutil.rmtree(generated)

for path in hashes:
    relative = path.lstrip("/")
    destination = web / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(private / relative, destination)

subprocess.run([sys.executable, str(root / "scripts/patch-client.py")], check=True)
shutil.copyfile(root / "scripts/home.js", web / "assets/bp-home.js")

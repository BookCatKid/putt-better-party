#!/usr/bin/env python3
"""Verify and build the archived client without accessing the network."""

import hashlib
import json
import pathlib
import posixpath
import re
import shutil
import struct
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


# The lock proves what is archived is intact, but says nothing about whether the
# bundles ask for something the lock does not carry. Reverse the references the
# client builds at runtime and require every one of them to be pinned, so a course
# piece, prop, skybox, sound or GLB texture that nobody archived fails the build
# instead of showing up as a missing model in a live round.
#
# The evidence behind each registry is in docs/dependency-inventory.md, and
# tests/assets.test.js asserts the same invariants so drift is caught either way.
def bundle_source(name):
    return (private / "assets" / name).read_text(errors="replace")


required = set()

# Course pieces and piece floors.
registry = bundle_source("registry-BaQMskdl.js")
for name in re.findall(r"`([\w./-]+\.glb)`", registry):
    required.add("/models/minigolf/" + name)

# Decor props. The bundle routes a small set to the minigolf models and the rest
# to decor/, and the nested graveyard and platformer sets live under decor/ too.
props = bundle_source("courseEventRuntime-Bzd93hOE.js")
minigolf_props = set(re.findall(r"`(lost-ball-[a-z]+|golf-club|golf-flag)`", props))
prop_start = props.index("tree:`tree_default.glb`")
for key, name in re.findall(r'[{,]"?([\w-]+)"?:`([^`]+\.glb)`', props[prop_start:]):
    folder = "minigolf" if key in minigolf_props else "decor"
    required.add(f"/models/{folder}/{name}")

# Theme skyboxes. Snow names none, because it is a gradient plus weather.
for name in re.findall(r"skybox:[a-z]\(`([^`]+\.webp)`\)", bundle_source("theme-BxxhUw0H.js")):
    required.add(name)

# Sound loader enumeration: `<name>-<n>.mp3` for n in 1..count.
loader = bundle_source("GameRoot-7kMtVtdO.js")
sound_counts = re.search(r"Ve=\{putt:4([^}]+)\}", loader)
if sound_counts is None:
    raise SystemExit("Could not read the sound registry; the build layout changed")
for name, count in re.findall(r"([a-z]+):(\d+)", sound_counts.group(0)):
    for index in range(1, int(count) + 1):
        required.add(f"/sfx/{name}-{index}.mp3")

# External resources named from inside a GLB, which no bundle mentions at all.
for path in hashes:
    if not path.endswith(".glb"):
        continue
    data = (private / path.lstrip("/")).read_bytes()
    if data[:4] != b"glTF":
        raise SystemExit(f"Archived model is not a binary glTF: {path}")
    chunk = struct.unpack("<I", data[12:16])[0]
    document = json.loads(data[20 : 20 + chunk].decode("utf-8"))
    resources = [image.get("uri") for image in document.get("images", [])]
    resources += [buffer.get("uri") for buffer in document.get("buffers", [])]
    for uri in resources:
        if not isinstance(uri, str) or uri.startswith("data:"):
            continue
        directory = posixpath.dirname(path)
        required.add(posixpath.join(directory, uri))

unpinned = sorted(required - set(hashes))
if unpinned:
    raise SystemExit(
        "The client needs assets the lock does not archive:\n  " + "\n  ".join(unpinned)
    )

print(f"Cross-checked {len(required)} runtime asset references against the lock", flush=True)

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

shutil.copyfile(root / "scripts/leaderboard.js", web / "assets/bp-leaderboard.js")

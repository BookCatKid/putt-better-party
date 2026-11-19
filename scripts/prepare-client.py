#!/usr/bin/env python3
"""Verify and build the archived client without accessing the network."""

import hashlib
import json
import os
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

# Build into a staging directory and publish only a complete build.
#
# The previous flow deleted the live `web/` and then copied and patched into it, so
# a patch failure - or an interrupt mid-copy - left a half-prepared client being
# served by the running process. Staging inverts that: nothing outside the stage is
# touched until every bundle has been patched and re-parsed, and publication is a
# directory rename, which is atomic on a POSIX filesystem. If anything fails, the
# previous build stays exactly as it was and remains servable.
staging = root / f".web-staging-{os.getpid()}"
previous = root / f".web-previous-{os.getpid()}"
for leftover in (staging, previous):
    if leftover.exists():
        shutil.rmtree(leftover)


def discard_staging():
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)


try:
    staging.mkdir(parents=True)
    for path in hashes:
        relative = path.lstrip("/")
        destination = staging / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(private / relative, destination)

    environment = dict(os.environ, BP_STAGE_WEB=str(staging))
    subprocess.run(
        [sys.executable, str(root / "scripts/patch-client.py")],
        check=True,
        env=environment,
    )

    shutil.copyfile(root / "scripts/replay-timeline.js", staging / "assets/replay-timeline.js")
    shutil.copyfile(root / "scripts/replay-page.js", staging / "assets/bp-replay-page.js")

    # Syntax-check every bundle whose bytes the patcher changed. A patch that
    # produces invalid JavaScript would otherwise only fail in the browser, after
    # publication, and only for whoever loads that route. Bundles are compared
    # against the archived originals, so an untouched copy is never re-checked.
    patched = []
    for archived_entry in (staging / "assets").glob("*.js"):
        original = private / "assets" / archived_entry.name
        if not original.is_file() or original.read_bytes() != archived_entry.read_bytes():
            patched.append(archived_entry.name)
    patched.sort()
    for name in patched:
        source = (staging / "assets" / name).read_text()
        # Parse as an ES module with the project's own runtime, so a bundle that
        # would break on `import`/`export` semantics is caught here rather than in
        # the browser. `--no-install` keeps the check fully offline.
        check = subprocess.run(
            [
                "bun",
                "--no-install",
                "-e",
                "const t=new Bun.Transpiler({loader:'js'});"
                "t.transformSync(await Bun.stdin.text());",
            ],
            input=source,
            text=True,
            capture_output=True,
        )
        if check.returncode != 0:
            raise SystemExit(f"Patched bundle does not parse: {name}\n{check.stderr}")
    print(
        f"Syntax-checked {len(patched)} patched bundle(s) before publishing",
        flush=True,
    )

    # Publish: swap the prepared stage into place. The rename is atomic, so a
    # concurrent request sees either the whole old build or the whole new one.
    if web.exists():
        web.rename(previous)
    staging.rename(web)
    if previous.exists():
        shutil.rmtree(previous, ignore_errors=True)
except BaseException:
    # Leave the previous build untouched and clean up the failed attempt.
    discard_staging()
    if not web.exists() and previous.exists():
        previous.rename(web)
    raise

#!/usr/bin/env python3
"""Diff a staged upstream capture against the pinned client.

Usage: python3 scripts/diff-capture.py captures/<snapshot>

Reports, as JSON on stdout:

  dependencies - every path the capture adds, changes or removes relative to
      `scripts/client-lock.json` (the verify-capture classification)
  media - registry-discovered model/sky/sound references the new bundles add
      or drop, computed by the same `registry_media()` the capture uses
  textures - external URIs named inside captured GLBs vs archived GLBs
  anchors - for each patch body, whether the new bundle still satisfies every
      counted anchor (run through patch-client.py --check-anchors semantics,
      in-process)

The report is read-only by design: it never updates the lock, never stages a
build, and never touches `private-client/`. Adopting a compatible upstream is
a human step on purpose.
"""

import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_module(name, path):
    """Import a sibling script by file location - the scripts are not a package."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def media_index(files):
    """Logical-name-keyed bundles, for comparing registry output across builds."""
    return files


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        raise SystemExit(2)
    capture_dir = pathlib.Path(sys.argv[1]).resolve()
    if not capture_dir.is_dir():
        print(json.dumps({"ok": False, "reason": "no-such-capture"}))
        raise SystemExit(2)
    manifest_path = capture_dir / "manifest.json"
    manifest = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            manifest = {}

    capture_client = load_module("capture_client", ROOT / "scripts/capture-client.py")
    verify = load_module("verify_capture", ROOT / "scripts/verify-capture.py")
    patcher = load_module("patch_client", ROOT / "scripts/patch-client.py")

    lock = json.loads((ROOT / "scripts/client-lock.json").read_text())

    # Dependencies: the same classification the capture verdict reports.
    dependencies = verify.classify_capture(capture_dir, manifest, lock)
    dependencies.pop("capture", None)

    # Registry/media: run the capture's own discovery over the new bundles and
    # over the archived ones, keyed by logical name so a hash-suffixed rename
    # compares the same module rather than double-reporting it.
    captured_js = {
        "/" + str(path.relative_to(capture_dir)): path.read_bytes()
        for path in (capture_dir / "assets").glob("*.js")
    }
    archived_js = {
        "/" + str(path.relative_to(ROOT / "private-client")): path.read_bytes()
        for path in (ROOT / "private-client/assets").glob("*.js")
    }
    captured_media = capture_client.registry_media(
        {capture_client.logical(p): data for p, data in captured_js.items()}
    )
    archived_media = capture_client.registry_media(
        {capture_client.logical(p): data for p, data in archived_js.items()}
    )
    media = {
        "added": sorted(captured_media - archived_media),
        "removed": sorted(archived_media - captured_media),
    }

    # External references named inside GLBs - the class of path no JavaScript
    # scan can see, so it is diffed from the binary chunks themselves.
    captured_glb = {
        p: data
        for p, data in (
            ("/" + str(x.relative_to(capture_dir)), x.read_bytes())
            for x in capture_dir.rglob("*.glb")
        )
    }
    archived_glb = {
        p: data
        for p, data in (
            ("/" + str(x.relative_to(ROOT / "private-client")), x.read_bytes())
            for x in (ROOT / "private-client").rglob("*.glb")
        )
    }
    captured_textures = (
        set().union(*(capture_client.textures(p, d) for p, d in captured_glb.items()))
        if captured_glb
        else set()
    )
    archived_textures = (
        set().union(*(capture_client.textures(p, d) for p, d in archived_glb.items()))
        if archived_glb
        else set()
    )
    textures = {
        "added": sorted(captured_textures - archived_textures),
        "removed": sorted(archived_textures - captured_textures),
    }

    anchors = patcher.check_anchors(capture_dir)

    print(
        json.dumps(
            {
                "capture": str(capture_dir),
                "dependencies": dependencies,
                "media": media,
                "textures": textures,
                "anchors": anchors,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

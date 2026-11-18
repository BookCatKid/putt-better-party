import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser(description="Prepare the pinned original client")
parser.add_argument(
    "--bundles-only", action="store_true", help="Build offline from the archived, pinned bundles"
)
args = parser.parse_args()

root = pathlib.Path(__file__).resolve().parent.parent
private = root / "private-client"
paths = {"/assets/" + x for x in (root / "scripts/assets.txt").read_text().splitlines()}
# Public static assets only; capture-client.py discovers and snapshots new builds.
paths.add("/favicon.ico")
# Known captured assets, plus stock sky paths. No gameplay or account API calls.
paths.update(
    "/models/minigolf/" + n + ".glb"
    for n in "ball-blue ball-red block bump-walls bump castle corner crest end flag-red gap hole-open hole-round hole-square narrow-block narrow-round narrow-square obstacle-block open ramp-high ramp-large-side ramp-low ramp-medium ramp round-corner-a round-corner-b round-corner-c round-large-corner side skew-corner skew-large-corner-open skew-large-corner split-start split-t split square-corner-a start straight structure-windmill support-low-bottom supports tunnel-double tunnel-wide walls-to-open".split()
)
paths.update(
    "/models/decor/" + n + ".glb"
    for n in "flower_purpleA flower_yellowA grass_large mushroom_red plant_bush plant_bushLarge rock_smallA tree_default tree_detailed tree_oak tree_pineTallA".split()
)
paths.update(
    [
        "/models/minigolf/Textures/colormap.png",
        "/models/decor/graveyard/Textures/colormap.png",
        "/models/decor/graveyard/gravestone-round.glb",
        "/models/decor/graveyard/hay-bale.glb",
        "/models/decor/platformer/Textures/colormap.png",
        "/models/decor/platformer/barrel.glb",
        "/sky/breezy.webp",
        "/sky/dawn.webp",
        "/sky/sunset.webp",
    ]
)
paths.update(
    f"/sfx/{n}-{i}.mp3"
    for n, k in dict(
        putt=4, iron=4, drive=4, bounce=4, hole=4, water=4, sand=3, clap=3, chip=3, swish=3
    ).items()
    for i in range(1, k + 1)
)
paths.update((root / "scripts/media-paths.txt").read_text().splitlines())


def get(path):
    p = private / path.lstrip("/")
    if p.exists() and p.stat().st_size > 0:
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            ["curl", "-fsSL", "--max-time", "20", "https://putt.day" + path, "-o", str(p)],
            check=True,
            capture_output=True,
        )
    except Exception as e:
        print("MISSING", path, str(e), flush=True)


hashes = json.loads((root / "scripts/client-lock.json").read_text())
if not args.bundles_only:
    # Only non-pinned media may be downloaded. Missing pinned bundles must
    # be recovered from version control, not replaced by an upstream build.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(get, sorted(paths - hashes.keys())))
for path, h in hashes.items():
    assert hashlib.sha256((private / path.lstrip("/")).read_bytes()).hexdigest() == h, path
print(f"Verified all {len(hashes)} pinned bundle hashes", flush=True)
web = root / "web"
web.mkdir(exist_ok=True)
for name in ("assets", "models", "sky", "sfx"):
    source = private / name
    if source.is_dir():
        shutil.copytree(source, web / name, dirs_exist_ok=True)
if not args.bundles_only:
    shutil.copyfile(private / "favicon.ico", web / "favicon.ico")
# Preserve the original hashed copies; patch only web.
subprocess.run([sys.executable, str(root / "scripts/patch-client.py")], check=True)

shutil.copyfile(root / "scripts/home.js", web / "assets/bp-home.js")

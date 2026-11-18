#!/usr/bin/env python3
"""Capture public static client artifacts directly from putt.day, without a HAR."""

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import re
import shutil
import struct
import subprocess
import tempfile
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

ROOT = pathlib.Path(__file__).resolve().parent.parent
ORIGIN = "https://putt.day"
ROUTES = ("/party", "/holes")
ALLOWED = re.compile(
    r"^/(?:assets|models|sfx|sky)/[A-Za-z0-9_./-]+\.(?:js|css|wasm|glb|png|webp|jpg|jpeg|mp3|woff2?|svg|ico)$|^/favicon\.ico$|^/logo192\.png$"
)
HASHED = re.compile(r"^(.+)-[\w-]{8}\.(js|css)$")


def logical(path):
    name = pathlib.PurePosixPath(path).name
    m = HASHED.fullmatch(name)
    return m.group(1) + "." + m.group(2) if m else name


def safe(path):
    return bool(ALLOWED.fullmatch(path)) and not {"..", "."}.intersection(path.split("/"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(path):
    # Never execute JS, send credentials, access a party, or follow redirects.
    if path not in ROUTES and not safe(path):
        raise ValueError("Unapproved static path: " + path)
    p = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--fail",
            "--connect-timeout",
            "10",
            "--max-time",
            "45",
            "--max-filesize",
            "30000000",
            "--write-out",
            "\n%{http_code}",
            ORIGIN + path,
        ],
        capture_output=True,
    )
    if p.returncode:
        raise RuntimeError(path + ": " + p.stderr.decode(errors="replace").strip())
    data, _, status = p.stdout.rpartition(b"\n")
    if status != b"200":
        raise RuntimeError(path + ": HTTP " + status.decode())
    if not data:
        raise RuntimeError(path + ": empty response")
    if path not in ROUTES and data.lstrip()[:30].lower().startswith((b"<!doctype html", b"<html")):
        raise RuntimeError(path + ": HTML instead of asset")
    return data


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()
        self.entry = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        v = a.get("href" if tag == "link" else "src", "")
        if tag not in ("link", "script") or not v:
            return
        u = urlsplit(urljoin(ORIGIN, v))
        if u.netloc == "putt.day" and u.scheme == "https" and safe(u.path):
            self.paths.add(u.path)
            if tag == "script" and a.get("type") == "module" and logical(u.path) == "index.js":
                self.entry = u.path


def imports(data):
    # Inspect literal module specifiers; Vite's route/preload manifest is handled separately.
    return {
        "/assets/" + x
        for x in re.findall(
            r'(?:from\s*|import\s*\(\s*|import\s*)["\x27\x60]\./([A-Za-z0-9_.-]+\.(?:js|css|wasm))["\x27\x60]',
            data.decode(errors="replace"),
        )
    }


def registry_media(files):
    paths = set()
    for name, data in files.items():
        if not name.endswith((".js", ".css")):
            continue
        s = data.decode(errors="replace")
        paths.update(
            "/" + m
            for m in re.findall(
                r'["\x27\x60]/((?:models|sky|sfx)/[\w./-]+\.(?:glb|webp|png|mp3))["\x27\x60]', s
            )
        )
        key = logical(name)
        if key == "registry.js":
            paths.update("/models/minigolf/" + m for m in re.findall(r"\x60([\w./-]+\.glb)\x60", s))
        if key == "courseEventRuntime.js":
            for a, b, v in re.findall(r'(?:\b([\w-]+)|"([\w-]+)"):\x60([\w./-]+\.glb)\x60', s):
                paths.add(
                    "/models/"
                    + (
                        "minigolf"
                        if (a or b)
                        in {
                            "lost-ball-blue",
                            "lost-ball-red",
                            "lost-ball-green",
                            "golf-club",
                            "golf-flag",
                        }
                        else "decor"
                    )
                    + "/"
                    + v
                )
        if key == "GameRoot.js":
            # Discover the table feeding the original sound preload loop.
            for m in re.finditer(r"\{(?:[\w-]+:\d+,?){5,}\}", s):
                table = dict(re.findall(r"([\w-]+):(\d+)", m.group()))
                if {"putt", "bounce", "hole"}.issubset(table):
                    paths.update(
                        f"/sfx/{k}-{i}.mp3" for k, n in table.items() for i in range(1, int(n) + 1)
                    )
    return {p for p in paths if safe(p)}


def textures(path, data):
    if not path.endswith(".glb") or data[:4] != b"glTF":
        return set()
    size, typ = struct.unpack_from("<II", data, 12)
    if typ != 0x4E4F534A:
        return set()
    j = json.loads(data[20 : 20 + size])
    out = set()
    for obj in j.get("images", []) + j.get("buffers", []):
        uri = obj.get("uri", "")
        if uri and not uri.startswith("data:"):
            u = urlsplit(urljoin(ORIGIN + path, uri))
            if u.netloc == "putt.day" and safe(u.path):
                out.add(u.path)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--output",
        type=pathlib.Path,
        default=ROOT / "captures" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S"),
        help="Staged snapshot directory (never the running client)",
    )
    args = ap.parse_args()
    dest = args.output.resolve()
    if (
        dest in (ROOT, ROOT / "private-client", ROOT / "web")
        or (ROOT / "private-client") in dest.parents
        or (ROOT / "web") in dest.parents
    ):
        ap.error("Choose a separate capture directory")
    if dest.exists():
        ap.error("Output already exists; use another --output path")
    dest.parent.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=".capture-", dir=dest.parent))
    files = {}
    missing = {}
    routes = {}
    entry = None

    def batch(paths):
        todo = sorted(set(paths) - set(files) - set(missing))
        if not todo:
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            jobs = {pool.submit(fetch, p): p for p in todo}
            for job in concurrent.futures.as_completed(jobs):
                p = jobs[job]
                try:
                    data = job.result()
                    files[p] = data
                    f = stage / p.lstrip("/")
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_bytes(data)
                except Exception as e:
                    missing[p] = str(e)

    try:
        for route in ROUTES:
            parser = Links()
            parser.feed(fetch(route).decode(errors="replace"))
            routes[route] = sorted(parser.paths)
            if parser.entry:
                entry = parser.entry
        if not entry:
            raise RuntimeError("No current entry module in public HTML")
        batch({entry})
        if entry not in files:
            raise RuntimeError(missing[entry])
        candidates = set().union(*map(set, routes.values()))
        candidates.update(
            "/" + p
            for p in re.findall(
                r'["\x27\x60](assets/[\w.-]+\.(?:js|css|wasm))["\x27\x60]',
                files[entry].decode(errors="replace"),
            )
        )
        lock = json.loads((ROOT / "scripts/client-lock.json").read_text())
        # Capture the complete discovered entry manifest, not just modules
        # that happened to exist in our previous snapshot.
        requested = candidates | {entry, "/favicon.ico", "/logo192.png"}
        batch(requested)
        while True:
            deps = set().union(*(imports(d) for p, d in files.items() if p.endswith(".js")))
            todo = deps - set(files) - set(missing)
            if not todo:
                break
            batch(todo)
        # The manifest supplements paths built dynamically; registry derivation captures new stock assets.
        media = registry_media(files) | {
            path for path in lock if path.startswith(("/models/", "/sky/", "/sfx/"))
        }
        batch(media)
        while True:
            deps = set().union(*(textures(p, d) for p, d in files.items() if p.endswith(".glb")))
            todo = deps - set(files) - set(missing)
            if not todo:
                break
            batch(todo)
        # Compare exact paths first. Several independent chunks can share a
        # logical stem (for example slim.js), so do not collapse them into
        # one arbitrary dictionary entry when reporting changed bundles.
        by_stem = {}
        for path in files:
            if path.startswith("/assets/"):
                by_stem.setdefault(logical(path), []).append(path)
        changes = []
        for previous, digest in sorted(lock.items()):
            if previous in files and sha(files[previous]) == digest:
                continue
            candidates = (
                sorted(by_stem.get(logical(previous), []))
                if previous.startswith("/assets/")
                else [previous]
                if previous in files
                else []
            )
            changes.append({"previous": previous, "captured_candidates": candidates})
        manifest = {
            "source": ORIGIN,
            "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "entry": entry,
            "routes": routes,
            "assets": {p: {"sha256": sha(d), "bytes": len(d)} for p, d in sorted(files.items())},
            "missing": missing,
            "changed_archived_assets": changes,
        }
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if dest.exists():
            raise RuntimeError("Output already exists; use a new --output path")
        stage.rename(dest)
        print(
            json.dumps(
                {
                    "snapshot": str(dest),
                    "assets": len(files),
                    "bytes": sum(map(len, files.values())),
                    "missing": missing,
                    "changed_archived_assets": changes,
                },
                indent=2,
            ),
            flush=True,
        )
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    main()

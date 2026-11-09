#!/usr/bin/env python3
"""Download immutable regional OSM extracts, resume partials and verify publisher hashes."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request
import zlib

STATES = {"TX": "texas", "FL": "florida", "NC": "north-carolina"}


def protobuf(data):
    """Read only wire types used by the PBF header, without an extra dependency."""
    index = 0

    def varint():
        nonlocal index
        result = shift = 0
        while index < len(data) and shift < 70:
            b = data[index]
            index += 1
            result |= (b & 127) << shift
            if not b & 128:
                return result
            shift += 7
        raise ValueError("Invalid PBF header varint")

    result = {}
    while index < len(data):
        key = varint()
        if key & 7 == 0:
            value = varint()
        elif key & 7 == 2:
            length = varint()
            value = data[index:index + length]
            if len(value) != length:
                raise ValueError("Truncated PBF header")
            index += length
        else:
            raise ValueError("Unsupported PBF header field")
        result[key >> 3] = value
    return result


def data_timestamp(path):
    with path.open("rb") as stream:
        size = int.from_bytes(stream.read(4), "big")
        if not 0 < size <= 65536:
            raise ValueError("Invalid PBF header size")
        header = protobuf(stream.read(size))
        if header[1] != b"OSMHeader" or header[3] > 1024 * 1024:
            raise ValueError("Invalid OSM PBF header")
        blob = protobuf(stream.read(header[3]))
        content = blob[1] if 1 in blob else zlib.decompress(blob[3])
        timestamp = protobuf(content)[32]
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def digest(path, algorithm):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(state, snapshot, root):
    directory = root / "raw" / "open-geocoder" / state.lower() / snapshot
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "data.osm.pbf"
    metadata = directory / "metadata.json"
    if metadata.exists():
        saved = json.loads(metadata.read_text())
        if saved["state"] != state or saved["snapshot"] != snapshot or digest(target, "sha256") != saved["sha256"]:
            raise ValueError("Cached OSM snapshot hash mismatch")
        print(str(metadata))
        return
    if shutil.disk_usage(root).free < 42 * 1024**3:
        raise ValueError("Download requires at least 42 GiB free, including the 40 GiB reserve")
    url = f"https://download.geofabrik.de/north-america/us/{STATES[state]}-{snapshot}.osm.pbf"
    with urllib.request.urlopen(url + ".md5", timeout=30) as response:
        publisher_md5 = response.read(4096).decode().split()[0]
    if not re.fullmatch(r"[a-f0-9]{32}", publisher_md5):
        raise ValueError("Invalid publisher checksum")
    part = directory / "data.osm.pbf.part"
    subprocess.run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                    "--retry", "3", "--connect-timeout", "30", "--max-time", "1800",
                    "--continue-at", "-", "--output", str(part), url], check=True)
    if digest(part, "md5") != publisher_md5:
        raise ValueError("Publisher MD5 mismatch; partial retained for inspection")
    sha = digest(part, "sha256")
    timestamp = data_timestamp(part)
    part.rename(target)
    saved = {"state": state, "snapshot": snapshot, "url": url, "publisher_md5": publisher_md5,
             "sha256": sha, "bytes": target.stat().st_size, "source": "OpenStreetMap via Geofabrik",
             "licence": "ODbL-1.0", "attribution": "© OpenStreetMap contributors",
             "data_timestamp": timestamp, "data_date": timestamp[:10]}
    temp = directory / "metadata.json.part"
    temp.write_text(json.dumps(saved, indent=2) + "\n")
    temp.rename(metadata)
    print(str(metadata))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("states", nargs="+", choices=STATES)
    parser.add_argument("--snapshot", required=True, help="Immutable Geofabrik YYMMDD extract, never latest")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{6}", args.snapshot):
        parser.error("snapshot must be YYMMDD")
    if not os.environ.get("OPENPLANS_DATA_DIR"):
        parser.error("OPENPLANS_DATA_DIR is required")
    root = Path(os.environ["OPENPLANS_DATA_DIR"]).resolve()
    checkout = Path(__file__).resolve().parents[3]
    if root == checkout or checkout in root.parents or any((p / ".git").exists() for p in (root, *root.parents)):
        parser.error("OPENPLANS_DATA_DIR must be outside the checkout")
    for state in args.states:
        download(state, args.snapshot, root)

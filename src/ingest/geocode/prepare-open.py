#!/usr/bin/env python3
"""Keep address search objects and their referenced geometry from a verified state extract."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime

PROFILE = "nominatim-address-v1"
FILTERS = ["nwr/addr:*", "nwr/place", "wr/highway", "wr/boundary", "r/type=associatedStreet"]
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("download_open", HERE / "download-open.py")
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


def filter_image():
    docker = ["docker", "--context", "colima-openplans-big"]
    image = "openplans-geocoder-filter:1"
    if subprocess.run(docker + ["image", "inspect", image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run(docker + ["build", "-t", image, "-f", str(HERE / "Dockerfile.filter"), str(HERE)], check=True)
    return docker, image


def object_timestamp(output, raw):
    docker, image = filter_image()
    command = docker + ["run", "--rm", "--memory", "512m", "--cpus", "1",
               "--label", "com.docker.compose.project=openplans-geocoder", "-v", str(output.parent) + ":/work:ro",
               image, "fileinfo", "--input-format", "pbf", "--extended", "--json", "/work/" + output.name]
    info = json.loads(subprocess.check_output(command, text=True))
    stamp = info["data"]["timestamp"]["last"]
    validate_timestamp(stamp, raw["data_timestamp"])
    return stamp


def validate_timestamp(stamp, replication):
    if datetime.fromisoformat(stamp.replace("Z", "+00:00")) > datetime.fromisoformat(replication.replace("Z", "+00:00")):
        raise ValueError("Address index object timestamp is newer than its snapshot")


def save_manifest(path, saved):
    temp = Path(str(path) + ".part")
    temp.write_text(json.dumps(saved, indent=2) + "\n")
    temp.rename(path)


def prepare(state, snapshot, root):
    subprocess.run(["python3", str(HERE / "download-open.py"), state, "--snapshot", snapshot], check=True)
    raw = json.loads((root / "raw/open-geocoder" / state.lower() / snapshot / "metadata.json").read_text())
    work = root / "work/open-geocoder"
    work.mkdir(parents=True, exist_ok=True)
    output = work / f"{state.lower()}-{snapshot}-addresses.osm.pbf"
    manifest = work / f"{state.lower()}-{snapshot}-address-index.json"
    if manifest.exists():
        saved = json.loads(manifest.read_text())
        if saved["raw_sha256"] != raw["sha256"] or saved["profile"] != PROFILE or saved["filters"] != FILTERS \
                or download.digest(output, "sha256") != saved["index_sha256"]:
            raise ValueError("Address index hash or scope mismatch")
        if "object_timestamp" not in saved:
            # Upgrade metadata by scanning the verified immutable input; never rebuild it.
            saved["object_timestamp"] = object_timestamp(output, raw)
            save_manifest(manifest, saved)
        validate_timestamp(saved["object_timestamp"], raw["data_timestamp"])
        print(str(manifest))
        return
    docker, image = filter_image()
    part = Path(str(output) + ".part")
    part.unlink(missing_ok=True)
    mounts = ["-v", str(root / "raw/open-geocoder") + ":/raw:ro", "-v", str(work) + ":/work"]
    common = docker + ["run", "--rm", "--memory", "6g", "--cpus", "2", "--label", "com.docker.compose.project=openplans-geocoder"] + mounts + [image]
    subprocess.run(common + ["tags-filter", "--no-progress", "--output-header=osmosis_replication_timestamp!", "-f", "pbf", "-o", "/work/" + part.name,
                            f"/raw/{state.lower()}/{snapshot}/data.osm.pbf"] + FILTERS, check=True)
    subprocess.run(common + ["check-refs", "-F", "pbf", "/work/" + part.name], check=True)
    if download.data_timestamp(part) != raw["data_timestamp"]:
        raise ValueError("Address index data timestamp differs")
    saved = {"state": state, "snapshot": snapshot, "profile": PROFILE, "filters": FILTERS, "raw_sha256": raw["sha256"],
             "index_sha256": download.digest(part, "sha256"), "bytes": part.stat().st_size, "data_timestamp": raw["data_timestamp"],
             "object_timestamp": object_timestamp(part, raw),
             "tool": "osmium-tool 1.16.0", "licence": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"}
    part.rename(output)
    save_manifest(manifest, saved)
    print(str(manifest))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("states", nargs="+", choices=download.STATES)
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    if not os.environ.get("OPENPLANS_DATA_DIR"):
        parser.error("OPENPLANS_DATA_DIR is required")
    for state in args.states:
        prepare(state, args.snapshot, Path(os.environ["OPENPLANS_DATA_DIR"]).resolve())

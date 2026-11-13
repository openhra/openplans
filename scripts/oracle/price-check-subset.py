#!/usr/bin/env python3
"""Cut a quarterly Part D SPUF archive down to the plans of the price-check sample.

Run with `python3 -I`. It reads the cached archive and writes `subset.zip` and `subset.json` to
the output directory. Nothing is fetched.

- Plan Information, Beneficiary Cost, Insulin Beneficiary Cost, Pricing and every part of the
  Pharmacy Networks file keep the header and the rows of the sample's plans (contract, plan and
  segment).
- The Basic Drugs Formulary keeps the rows of those plans' formularies, plus every row of an NDC
  the sample names, so a lookup of an NDC across the release still finds the same rows.
- The other members are copied byte for byte. The sample files member is left out.

Filtering renumbers a member's rows, so a row's position in the subset is not its position in
the CMS file. `subset.json` records the SHA-256 of every member read from the source archive, the rows
read and kept, and the SHA-256 of the subset. A second run with the same archive, cases and script
reuses the subset and rewrites nothing. The subset bytes are the same on every run.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile

VERSION = 1
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
PLAN_KEYED = (
    "plan information ",
    "beneficiary cost file ",
    "insulin beneficiary cost file ",
    "pricing file ",
    "pharmacy networks file ",
)
FORMULARY = "basic drugs formulary file "
DROPPED = ("sample files ",)
CHUNK = 1 << 20


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def kind(member):
    name = member.lower()
    if name.startswith(DROPPED):
        return "dropped"
    if name.startswith(FORMULARY):
        return "formulary"
    if name.startswith(PLAN_KEYED):
        return "plan"
    return "copied"


def sample(cases_file):
    with open(cases_file, "rb") as handle:
        raw = handle.read()
    cases = json.loads(raw)["cases"]
    plans = set()
    for item in cases:
        contract, plan, segment = item["plan_key"].split("-")
        plans.add((contract, plan, int(segment)))
    return hashlib.sha256(raw).hexdigest(), plans, {item["ndc"] for item in cases}


def columns(header, names):
    fields = header.rstrip(b"\r\n").split(b"|")
    found = []
    for name in names:
        if name.encode() not in fields:
            raise SystemExit(f"column {name} missing from {header[:80]!r}")
        found.append(fields.index(name.encode()))
    return found


def plan_key(fields, at):
    try:
        return (fields[at[0]].decode(), fields[at[1]].decode(), int(fields[at[2]]))
    except (ValueError, IndexError):
        return None


def filter_text(source, target, keep):
    """Copy the header and the rows `keep` accepts; returns (rows read, rows kept)."""
    header = source.readline()
    target.write(header)
    test = keep(header)
    read = kept = 0
    for line in source:
        if not line.strip():
            continue
        read += 1
        if test(line):
            target.write(line)
            kept += 1
    return read, kept


def plan_rows(plans):
    def keep(header):
        at = columns(header, ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID"])
        last = max(at) + 1
        return lambda line: plan_key(line.split(b"|", last), at) in plans

    return keep


def formulary_rows(formularies, ndcs):
    wanted_f = {f.encode() for f in formularies}
    wanted_n = {n.encode() for n in ndcs}

    def keep(header):
        f, n = columns(header, ["FORMULARY_ID", "NDC"])
        last = max(f, n) + 1

        def test(line):
            fields = line.split(b"|", last)
            return fields[f] in wanted_f or fields[n] in wanted_n

        return test

    return keep


def copy_member(outer, member, scratch):
    """Extracts one outer member to a temp file; returns (path, sha256 of its bytes)."""
    path = os.path.join(scratch, "member.zip")
    digest = hashlib.sha256()
    with outer.open(member) as source, open(path, "wb") as target:
        for block in iter(lambda: source.read(CHUNK), b""):
            digest.update(block)
            target.write(block)
    return path, digest.hexdigest()


def filter_member(path, scratch, keep):
    """Writes a filtered copy of an inner zip; returns (path, rows read, rows kept)."""
    out = os.path.join(scratch, "filtered.zip")
    read = kept = 0
    with zipfile.ZipFile(path) as inner, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as target:
        for entry in inner.infolist():
            if entry.is_dir():
                continue
            info = zipfile.ZipInfo(entry.filename, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            with inner.open(entry) as source, target.open(info, "w") as sink:
                r, k = filter_text(source, sink, keep)
            read += r
            kept += k
    return out, read, kept


def plan_formularies(outer, member, scratch, plans):
    path, _ = copy_member(outer, member, scratch)
    found = {}
    with zipfile.ZipFile(path) as inner:
        for entry in inner.infolist():
            with inner.open(entry) as source:
                header = source.readline()
                at = columns(header, ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID"])
                (f,) = columns(header, ["FORMULARY_ID"])
                for line in source:
                    fields = line.rstrip(b"\r\n").split(b"|")
                    key = plan_key(fields, at)
                    if key in plans:
                        found.setdefault(key, set()).add(fields[f].decode())
    os.remove(path)
    missing = sorted(plans - set(found))
    if missing:
        raise SystemExit(f"plans missing from {member}: {missing}")
    return sorted({f for values in found.values() for f in values})


def reusable(manifest_file, subset_file, source_sha, cases_sha):
    try:
        with open(manifest_file, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError):
        return None
    if (
        manifest.get("version") == VERSION
        and manifest.get("source", {}).get("sha256") == source_sha
        and manifest.get("cases_sha256") == cases_sha
        and os.path.exists(subset_file)
        and sha256_file(subset_file) == manifest.get("subset", {}).get("sha256")
    ):
        return manifest
    return None


def build(archive, cases_file, out_dir, source_sha=None):
    os.makedirs(out_dir, exist_ok=True)
    manifest_file = os.path.join(out_dir, "subset.json")
    subset_file = os.path.join(out_dir, "subset.zip")
    cases_sha, plans, ndcs = sample(cases_file)
    source_sha = source_sha or sha256_file(archive)
    found = reusable(manifest_file, subset_file, source_sha, cases_sha)
    if found:
        return found, "reused"
    scratch = tempfile.mkdtemp(prefix="price-check-subset-", dir=out_dir)
    partial = os.path.join(out_dir, "subset.zip.partial")
    members = []
    try:
        with zipfile.ZipFile(archive) as outer, zipfile.ZipFile(
            partial, "w", zipfile.ZIP_STORED
        ) as target:
            names = sorted(i.filename for i in outer.infolist() if not i.is_dir())
            plan_member = [n for n in names if n.lower().startswith("plan information ")]
            if len(plan_member) != 1:
                raise SystemExit("the archive needs exactly one plan information member")
            formularies = plan_formularies(outer, plan_member[0], scratch, plans)
            for name in names:
                action = kind(name)
                path, member_sha = copy_member(outer, name, scratch)
                record = {"member": name, "sha256": member_sha, "action": action}
                if action == "plan":
                    path, record["rows_read"], record["rows_kept"] = filter_member(
                        path, scratch, plan_rows(plans)
                    )
                elif action == "formulary":
                    path, record["rows_read"], record["rows_kept"] = filter_member(
                        path, scratch, formulary_rows(formularies, ndcs)
                    )
                if action != "dropped":
                    record["output_sha256"] = sha256_file(path)
                    info = zipfile.ZipInfo(name, FIXED_TIME)
                    info.compress_type = zipfile.ZIP_STORED
                    with open(path, "rb") as source, target.open(info, "w") as sink:
                        shutil.copyfileobj(source, sink, CHUNK)
                members.append(record)
        os.replace(partial, subset_file)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        if os.path.exists(partial):
            os.remove(partial)
    manifest = {
        "version": VERSION,
        "source": {"path": archive, "sha256": source_sha},
        "cases_sha256": cases_sha,
        "plans": sorted(f"{c}-{p}-{s}" for c, p, s in plans),
        "formularies": formularies,
        "ndcs": sorted(ndcs),
        "members": members,
        "subset": {
            "sha256": sha256_file(subset_file),
            "bytes": os.path.getsize(subset_file),
        },
    }
    with open(manifest_file + ".partial", "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
        handle.write("\n")
    os.replace(manifest_file + ".partial", manifest_file)
    return manifest, "built"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("archive")
    parser.add_argument("--cases", required=True)
    parser.add_argument("--output", required=True, help="directory for subset.zip and subset.json")
    parser.add_argument(
        "--source-sha256",
        help="the archive's SHA-256 as the cache recorded it; computed when absent",
    )
    args = parser.parse_args(argv)
    manifest, outcome = build(args.archive, args.cases, args.output, args.source_sha256)
    print(
        f"{outcome} price-check subset: {len(manifest['plans'])} plans, "
        f"{manifest['subset']['bytes']} bytes, sha256 {manifest['subset']['sha256']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

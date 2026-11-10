"""Stream CMS Part D networks and pricing with bounded memory, using only the archive bytes."""
import argparse
import contextlib
import hashlib
import json
import resource
import shutil
import sys
import tempfile
import time
import zipfile
from decimal import Decimal

PREFIXES = {
    "plan": "plan information ",
    "formulary": "basic drugs formulary file ",
    "pharmacy_network": "pharmacy networks file ",
    "pricing": "pricing file ",
}
MODULUS = 1 << 256


@contextlib.contextmanager
def inner_table(outer, name):
    # Inner ZIPs need seeking. Spill to disk instead of retaining a 400 MB member in memory.
    with tempfile.TemporaryFile() as spool:
        with outer.open(name) as source:
            shutil.copyfileobj(source, spool, 1024 * 1024)
        spool.seek(0)
        with zipfile.ZipFile(spool) as inner:
            member = next(i for i in inner.infolist() if i.filename.lower().endswith(".txt"))
            with inner.open(member) as source:
                yield member, source


def inventory(path):
    files = []
    with zipfile.ZipFile(path) as outer:
        for member in sorted(outer.infolist(), key=lambda m: m.filename):
            if member.filename.lower().startswith("sample files"):
                continue
            started = time.monotonic()
            with inner_table(outer, member.filename) as (text, source):
                rows, last = 0, b""
                while block := source.read(1024 * 1024):
                    rows += block.count(b"\n")
                    last = block[-1:]
                rows += int(last != b"\n" and last != b"")
                files.append({"file": member.filename, "text_file": text.filename,
                              "zip_bytes": member.file_size, "text_bytes": text.file_size,
                              "rows": max(0, rows - 1), "stream_seconds": round(time.monotonic() - started, 3)})
    return {"files": files, "peak_rss_bytes": peak_rss()}


def peak_rss():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def key(row):
    return f'{row["CONTRACT_ID"]}-{row["PLAN_ID"].zfill(3)}-{int(row["SEGMENT_ID"])}'


def add(groups, group, line):
    count, total = groups.get(group, (0, 0))
    groups[group] = (count + 1, (total + int.from_bytes(hashlib.sha256(line.encode()).digest(), "big")) % MODULUS)


def finish(groups):
    return {k: [n, f"{s:064x}"] for k, (n, s) in sorted(groups.items())}


def large_read(path, modulus, sample_archive):
    plans, formularies, headers = {}, set(), {}
    raw_rows, selected_rows = {}, {}
    groups = {"pharmacy_network": {}, "pricing": {}}
    pharmacy_sample, price_sample = [], []
    drug_queries, ndc_queries = {}, {}
    started = time.monotonic()
    archive_out = zipfile.ZipFile(sample_archive, "w", compression=zipfile.ZIP_STORED) if sample_archive else None
    try:
        with zipfile.ZipFile(path) as outer:
            for table, prefix in PREFIXES.items():
                names = sorted(n for n in outer.namelist() if n.lower().startswith(prefix))
                raw_rows[table] = selected_rows[table] = 0
                if not names:
                    continue
                current, network = None, []

                def finish_network():
                    if not network or (modulus == 1 and len(plans) > 100 and int(hashlib.sha256(current.encode()).hexdigest(), 16) % 100):
                        return
                    zip_set = {p[1] for p in network}
                    zips = sorted(zip_set)
                    for postal in sorted({zips[0], zips[len(zips) // 2], zips[-1]}):
                        pharmacies = sorted((p for p in network if p[1] == postal), key=lambda p: p[0])[:500]
                        pharmacy_sample.append({"plan_key": current, "zip": postal, "status": "available",
                                                "pharmacies": [[p[0], *p[2:]] for p in pharmacies]})
                    missing = next(f"{n:05d}" for n in range(100000) if f"{n:05d}" not in zip_set)
                    pharmacy_sample.append({"plan_key": current, "zip": missing, "status": "available", "pharmacies": []})

                for name in names:
                    with inner_table(outer, name) as (member, source), tempfile.TemporaryFile() as subset:
                        header_line = source.readline()
                        head = [c.strip().upper() for c in header_line.decode("cp1252").rstrip("\r\n").split("|")]
                        assert len(head) == len(set(head)), head
                        if table in headers:
                            assert headers[table] == head
                        headers[table] = head
                        subset.write(header_line)
                        # Large tables start with the three plan columns. Hash only once per plan.
                        if table in ("pharmacy_network", "pricing"):
                            assert head[:3] == ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID"]
                        previous_prefix, chosen = None, False
                        for line in source:
                            raw_rows[table] += 1
                            if table in ("pharmacy_network", "pricing"):
                                parts = line.split(b"|", 3)
                                plan_prefix = tuple(parts[:3])
                                if previous_prefix != plan_prefix:
                                    previous_prefix = plan_prefix
                                    plan = f'{parts[0].decode().strip()}-{parts[1].decode().strip().zfill(3)}-{int(parts[2])}'
                                    chosen = plan in plans
                                if not chosen:
                                    continue
                            cells = [c.strip() for c in line.decode("cp1252").rstrip("\r\n").split("|")]
                            row = dict(zip(head, cells))
                            if table == "plan":
                                plan = key(row)
                                if int(hashlib.sha256(plan.encode()).hexdigest(), 16) % modulus:
                                    continue
                                entry = plans.setdefault(plan, {"formularies": set(), "suppressed": False})
                                entry["formularies"].add(row["FORMULARY_ID"])
                                entry["suppressed"] |= row["PLAN_SUPPRESSED_YN"] == "Y"
                                formularies.add(row["FORMULARY_ID"])
                            elif table == "formulary":
                                if row["FORMULARY_ID"] not in formularies:
                                    continue
                                # Keep the first three RxCUIs per formulary for unit-cost serving checks.
                                queries = drug_queries.setdefault(row["FORMULARY_ID"], {})
                                if row["RXCUI"] in queries or len(queries) < 3:
                                    queries.setdefault(row["RXCUI"], set()).add(row["NDC"])
                            elif table == "pharmacy_network":
                                if current != plan:
                                    finish_network()
                                    current, network = plan, []
                                pharmacy = row["PHARMACY_NUMBER"]
                                assert len(pharmacy) == 12 and pharmacy.startswith("10") and pharmacy[2] in "12"
                                npi, postal = pharmacy[2:], row["PHARMACY_ZIPCODE"]
                                values = [row[c] for c in head[5:]]
                                assert head[3:5] == ["PHARMACY_NUMBER", "PHARMACY_ZIPCODE"]
                                add(groups[table], plan, "|".join([npi, postal, *values]))
                                network.append([npi, postal, *[row.get(c) == v for c, v in (
                                    ("PHARMACY_RETAIL", "Y"), ("PHARMACY_MAIL", "Y"),
                                    ("PREFERRED_STATUS_RETAIL", "Y"), ("PREFERRED_STATUS_MAIL", "Y"), ("IN_AREA_FLAG", "1"))]])
                            elif table == "pricing":
                                cost = format(Decimal(row["UNIT_COST"]), ".4f")
                                days = int(row["DAYS_SUPPLY"])
                                add(groups[table], plan, f'{row["NDC"]}|{days}|{cost}')
                                for query in ndc_queries.get((plan, row["NDC"]), []):
                                    query["rows"].append([row["NDC"], days, cost])
                            selected_rows[table] += 1
                            if archive_out:
                                subset.write(line)
                        print(f"{table}: {name}: raw={raw_rows[table]} selected={selected_rows[table]}", file=sys.stderr, flush=True)
                        if archive_out:
                            subset.seek(0)
                            with tempfile.TemporaryFile() as inner_out:
                                with zipfile.ZipFile(inner_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as target:
                                    with target.open(member.filename, "w", force_zip64=True) as writer:
                                        shutil.copyfileobj(subset, writer, 1024 * 1024)
                                inner_out.seek(0)
                                with archive_out.open(name, "w", force_zip64=True) as writer:
                                    shutil.copyfileobj(inner_out, writer, 1024 * 1024)
                if table == "pharmacy_network":
                    finish_network()
                if table == "formulary":
                    for plan, info in sorted(plans.items()):
                        if info["suppressed"] or len(info["formularies"]) != 1 or (modulus == 1 and len(plans) > 100 and int(hashlib.sha256(plan.encode()).hexdigest(), 16) % 100):
                            continue
                        for rxcui, ndcs in sorted(drug_queries.get(next(iter(info["formularies"])), {}).items()):
                            query = {"plan_key": plan, "rxcui": rxcui, "status": "available", "rows": []}
                            price_sample.append(query)
                            for ndc in ndcs:
                                ndc_queries.setdefault((plan, ndc), []).append(query)
        for query in price_sample:
            query["rows"].sort()
            query["status"] = "available" if query["rows"] else "unknown"
            if "pricing" not in headers:
                query["reason"] = "pricing_not_loaded"
        return {"headers": headers, "raw_rows": raw_rows, "rows": selected_rows,
                "groups": {t: finish(g) for t, g in groups.items()},
                "plans": sorted(plans), "pharmacy_sample": pharmacy_sample, "price_sample": price_sample,
                "sample_modulus": modulus, "elapsed_seconds": round(time.monotonic() - started, 3),
                "peak_rss_bytes": peak_rss()}
    finally:
        if archive_out:
            archive_out.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--inventory", action="store_true")
    parser.add_argument("--large", action="store_true")
    parser.add_argument("--sample-modulus", type=int, default=1000)
    parser.add_argument("--sample-archive")
    args = parser.parse_args()
    if args.sample_modulus < 1:
        parser.error("sample modulus must be positive; 1 checks every plan")
    result = inventory(args.archive) if args.inventory else large_read(args.archive, args.sample_modulus, args.sample_archive)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()

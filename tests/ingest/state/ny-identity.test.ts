import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCents } from "../../../src/domain/rating/index.js";
import { nyFiledIdentity } from "../../../src/ingest/state/ny-identity.js";
import type { NyIdentityPublication } from "../../../src/ingest/state/ny-identity.js";
import type { StateCatalogRow } from "../../../src/ingest/state/catalog.js";

// SYNTHETIC source cells and identity. These are not real plan facts or premiums.
function fixture() {
  const price = parseCents("123.45");
  const row: StateCatalogRow = {
    state: "NY",
    plan_year: 2026,
    region: "Rating Area 4",
    import_id: "SYNTHETIC",
    publication_snapshot_id: "SYNTHETIC",
    record_index: 1,
    plan_key: "99999NY0010001",
    rules_document: {},
    hios_id: null,
    hios_match: null,
    hios_match_reason: null,
    hios_candidates: null,
    hios_match_rule: null,
    hios_match_provenance: null,
    raw_record: {
      plan_id: "99999NY0010001",
      issuer: "99999",
      metal: null,
      exchange: "unknown",
      prices: {},
      raw: {},
    },
    rate: {
      state: "NY",
      planYear: 2026,
      planKey: "99999NY0010001",
      region: "Rating Area 4",
      childOnly: false,
      prices: {
        single: price,
        couple: price,
        adult_children: price,
        family: price,
      },
      provenance: {
        sourceUrl: "https://example.test/SYNTHETIC-rates",
        sourceSha256: "a".repeat(64),
        sourceRecord: "SYNTHETIC#row=1",
      },
    },
  };
  const publication: NyIdentityPublication = {
    rate_url: row.rate.provenance.sourceUrl,
    rate_sha256: row.rate.provenance.sourceSha256,
    url: "https://example.test/SYNTHETIC-exhibit",
    sha256: "b".repeat(64),
    member: "SYNTHETIC.xlsm",
    headers: {
      "3": "4. Market",
      "4": "5. Current HIOS ID (16 Digits)",
      "6": "7. Metal Level or Catastrophic",
      "7": "8. Exchange / CSR Type",
      "73": "Region 4 - 2026 Rate (New York)",
    },
    rows: [
      {
        source_row: 4,
        cells: {
          "3": "Individual",
          "4": "99999NY001000100",
          "6": "Silver",
          "7": "Off",
          "16": "No",
          "73": "123.45000000000001",
        },
      },
    ],
  };
  return { row, publication };
}

it("maps only current variant IDs and cites explicit metal, Exchange and 2026 regional cells", () => {
  const { row, publication } = fixture();
  expect(nyFiledIdentity(row, [publication])).toMatchObject({
    metal: "Silver",
    off_exchange: true,
    source: "ny_dfs_exhibit_23",
    source_rows: [4],
    price_rows: [4],
    columns: {
      current_hios_id: "E",
      metal: "G",
      exchange_csr_type: "H",
      region_price: "BV",
    },
  });
  publication.rows.push({
    source_row: 5,
    cells: {
      ...publication.rows[0]!.cells,
      "4": "99999NY001000101",
      "7": "On",
    },
  });
  expect(nyFiledIdentity(row, [publication])).toMatchObject({
    metal: "Silver",
    off_exchange: false,
  });
});

it("SYNTHETIC mutants cannot assign metal across changed source, year, region, price, market or identity", () => {
  const mutations: ((r: StateCatalogRow, p: NyIdentityPublication) => void)[] =
    [
      (r) => {
        r.plan_year = 2025;
      },
      (r) => {
        r.state = "VT";
      },
      (r) => {
        r.region = "New York";
      },
      (r) => {
        r.raw_record.plan_id += "-01";
      },
      (r) => {
        r.rate.provenance.sourceSha256 = "c".repeat(64);
      },
      (r) => {
        r.rate.provenance.sourceUrl += "other";
      },
      (r) => {
        r.rate.prices = { ...r.rate.prices, single: parseCents("123.46") };
      },
      (_r, p) => {
        p.headers["73"] = "Region 4 - 2025 Rate (New York)";
      },
      (_r, p) => {
        p.headers["4"] = "6. Previous HIOS ID (16 Digits)";
      },
      (_r, p) => {
        p.rows[0]!.cells["5"] = p.rows[0]!.cells["4"]!;
        delete p.rows[0]!.cells["4"];
      },
      (_r, p) => {
        p.rows[0]!.cells["3"] = "Small Group";
      },
      (_r, p) => {
        p.rows[0]!.cells["6"] = "unknown";
      },
      (_r, p) => {
        p.rows[0]!.cells["73"] = "";
      },
      (_r, p) => {
        p.rows.push({
          source_row: 5,
          cells: { ...p.rows[0]!.cells, "6": "Gold" },
        });
      },
    ];
  for (const mutate of mutations) {
    const { row, publication } = fixture();
    expect(nyFiledIdentity(row, [publication])).not.toBeNull();
    mutate(row, publication);
    expect(nyFiledIdentity(row, [publication])).toBeNull();
  }
  const { row, publication } = fixture();
  delete publication.rows[0]!.cells["7"];
  expect(nyFiledIdentity(row, [publication])).toMatchObject({
    metal: "Silver",
    off_exchange: false,
  });
});

it("cached byte corruption fails the source-cut verifier", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import hashlib, importlib.util, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('ny_identity', pathlib.Path(sys.argv[1]) / 'ny-identity.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
# SYNTHETIC bytes, never a mutation of a real cached publication.
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'synthetic-publication'
    path.write_bytes(b'SYNTHETIC source')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert module.verified(path, digest) == b'SYNTHETIC source'
    path.write_bytes(b'SYNTHETIC mutant')
    try: module.verified(path, digest)
    except ValueError: pass
    else: raise AssertionError('Corrupt source mutant was accepted')
print('PASS')
`,
      fileURLToPath(new URL("../../../src/ingest/state/", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("PASS");
});

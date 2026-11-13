import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compareLarge,
  largeNegativeControls,
  readLargeActual,
  rowAccumulator,
} from "../../../scripts/oracle/medicare-part-d-large-logic.mjs";
import type { LargeReference } from "../../../scripts/oracle/medicare-part-d-large-logic.mjs";
import { migrate } from "../../../src/db/migrate.js";
import { parsePlanKey } from "../../../src/domain/medicare/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../../src/ingest/medicare/spuf.js";
import {
  partDDrug,
  partDPharmacies,
} from "../../../src/services/medicare-part-d.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { lookup, spufUrl, zip } from "./helpers.js";

const script = fileURLToPath(
  new URL(
    "../../../scripts/oracle/medicare-part-d-reference.py",
    import.meta.url,
  ),
);

/** Entirely synthetic identifiers and costs; nested members exercise a network across two ZIPs. */
function syntheticArchive(monthly = false) {
  const table = (header: string, rows: string[]) =>
    Buffer.from([header, ...rows, ""].join("\r\n"));
  const networkHeader =
    "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER|PHARMACY_ZIPCODE|PREFERRED_STATUS_RETAIL|PREFERRED_STATUS_MAIL|PHARMACY_RETAIL|PHARMACY_MAIL|IN_AREA_FLAG|FLOOR_PRICE";
  const pharmacy = (
    plan: string,
    npi: string,
    postal: string,
    preferred = "Y",
  ) => `H9000|${plan}|000|10${npi}|${postal}|${preferred}|N|Y|N|1|0`;
  const files: Record<string, Buffer> = {
    "plan information synthetic.zip": table(
      "CONTRACT_ID|PLAN_ID|SEGMENT_ID|FORMULARY_ID|PREMIUM|DEDUCTIBLE|PLAN_SUPPRESSED_YN",
      [
        "H9000|001|000|99990000|0|0|N",
        "H9000|002|000|99990000|0|0|N",
        "H9000|003|000|99990000|0|0|N",
      ],
    ),
    "basic drugs formulary file synthetic.zip": table(
      "FORMULARY_ID|RXCUI|NDC|TIER_LEVEL_VALUE|PRIOR_AUTHORIZATION_YN|STEP_THERAPY_YN|QUANTITY_LIMIT_YN",
      [
        "99990000|999900001|99990000001|1|N|N|N",
        "99990000|999900002|99990000002|2|N|N|N",
      ],
    ),
    "pharmacy networks file synthetic part 1.zip": table(networkHeader, [
      pharmacy("001", "1000000001", "90001"),
    ]),
    "pharmacy networks file synthetic part 2.zip": table(networkHeader, [
      pharmacy("001", "1000000002", "90002", "N"),
      pharmacy("002", "1000000001", "90001"),
      pharmacy("002", "1000000002", "90002", "N"),
      pharmacy("003", "1000000003", "00000"),
    ]),
  };
  if (!monthly)
    files["pricing file synthetic.zip"] = table(
      "CONTRACT_ID|PLAN_ID|SEGMENT_ID|NDC|DAYS_SUPPLY|UNIT_COST",
      [
        "H9000|001|000|99990000001|30|1.23",
        "H9000|001|000|99990000001|90|0.0001",
        "H9000|002|000|99990000001|30|0",
        "H9000|003|000|99990000002|60|2.3456",
      ],
    );
  return zip(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        zip({ "synthetic.txt": bytes }),
      ]),
    ),
  );
}

describe("Part D network and price check on synthetic archives", () => {
  let directory: string;
  beforeAll(async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    directory = await mkdtemp(join(tmpdir(), "part-d-large-test-"));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function reference(path: string, modulus = 1, subset?: string) {
    const result = spawnSync(
      "python3",
      [
        "-I",
        script,
        path,
        "--large",
        "--sample-modulus",
        String(modulus),
        ...(subset ? ["--sample-archive", subset] : []),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as LargeReference;
  }

  async function loaded(monthly = false, modulus = 1) {
    const migrations = await coreMigrations();
    const dataDir = await mkdtemp(join(directory, "cache-"));
    const db = testDatabase(new PGlite());
    const bytes = syntheticArchive(monthly);
    const raw = join(dataDir, "raw.zip"),
      subset = join(dataDir, "subset.zip");
    await writeFile(raw, bytes);
    const expected = reference(
      raw,
      modulus,
      modulus === 1 ? undefined : subset,
    );
    await migrate(db, migrations.directory);
    const url = monthly ? spufUrl.replace("SPUF_2026_", "2026_") : spufUrl;
    await acquireSpuf(parseSpufUrl(url)!, {
      dataDir,
      dependencies: {
        lookup,
        transport: async () => ({
          status: 200,
          headers: { "content-type": "application/zip" },
          body: Readable.from([bytes]),
        }),
      },
    });
    const cached = (
      await cachedSpuf(monthly ? "monthly" : "quarterly", dataDir)
    )[0]!;
    const imported = await importSpuf(
      db,
      modulus === 1 ? cached : { ...cached, path: subset },
      [
        "plan",
        "formulary",
        "pharmacy_network",
        ...(monthly ? [] : ["pricing" as const]),
      ],
    );
    const read = () =>
      readLargeActual(
        db,
        imported.snapshot_id,
        expected,
        (key, postal) => partDPharmacies(db, parsePlanKey(key)!, 2026, postal),
        (key, rxcui) => partDDrug(db, parsePlanKey(key)!, 2026, rxcui),
      );
    return {
      db,
      expected,
      imported,
      read,
      close: async () => {
        await db.close();
        await migrations.cleanup();
      },
    };
  }

  it("checks all network memberships, shared networks, prices and absent evidence", async () => {
    const state = await loaded();
    try {
      const actual = await state.read();
      expect(compareLarge(state.expected, actual)).toEqual([]);
      expect(actual.rows).toEqual({ pharmacy_network: 5, pricing: 4 });
      expect(
        actual.pharmacy_sample.some(
          (q) => q.zip === "00000" && q.pharmacies.length > 0,
        ),
      ).toBe(true);
      expect(
        actual.pharmacy_sample.some(
          (q) =>
            q.plan_key === "H9000-003-0" &&
            q.zip === "00001" &&
            q.pharmacies.length === 0,
        ),
      ).toBe(true);
      expect(state.imported.counts.pharmacy_networks_distinct).toBe(2);
      expect(actual.price_sample.some((q) => q.status === "unknown")).toBe(
        true,
      );
      expect(
        Object.values(largeNegativeControls(state.expected, actual)),
      ).toEqual(Array(10).fill(true));
    } finally {
      await state.close();
    }
  }, 180_000);

  it("reports missing monthly pricing as unknown and rejects false availability", async () => {
    const state = await loaded(true);
    try {
      const actual = await state.read();
      expect(compareLarge(state.expected, actual)).toEqual([]);
      expect(
        actual.price_sample.every((q) => q.reason === "pricing_not_loaded"),
      ).toBe(true);
      expect(
        Object.values(largeNegativeControls(state.expected, actual)),
      ).toEqual(Array(6).fill(true));
    } finally {
      await state.close();
    }
  }, 180_000);

  it("selects plans by a stable hash and imports the unmodified selected raw lines", async () => {
    const state = await loaded(false, 2);
    try {
      const selected = ["H9000-001-0", "H9000-002-0", "H9000-003-0"].filter(
        (k) =>
          BigInt(`0x${createHash("sha256").update(k).digest("hex")}`) % 2n ===
          0n,
      );
      expect(state.expected.plans).toEqual(selected);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.length).toBeLessThan(3);
      expect(compareLarge(state.expected, await state.read())).toEqual([]);
    } finally {
      await state.close();
    }
  }, 180_000);

  it.each([
    [
      "network membership",
      "DELETE FROM partd_network_pharmacy WHERE npi='1000000002'",
      /^pharmacy_network /,
    ],
    [
      "NPI",
      "UPDATE partd_network_pharmacy SET npi='1000000009' WHERE npi='1000000002'",
      /^pharmacy_network /,
    ],
    [
      "ZIP",
      "UPDATE partd_network_pharmacy SET zip='90009' WHERE npi='1000000002'",
      /^pharmacy_network /,
    ],
    [
      "preferred flag",
      `UPDATE partd_network_pharmacy SET cells=jsonb_set(cells,'{PREFERRED_STATUS_RETAIL}','"N"') WHERE npi='1000000001'`,
      /^pharmacy_sample /,
    ],
    [
      "network plan assignment",
      "UPDATE partd_plan_network SET network_id=(SELECT network_id FROM partd_plan_network WHERE plan_id='003') WHERE plan_id='001'",
      /^pharmacy_network /,
    ],
    [
      "unit cost",
      "UPDATE partd_plan_unit_cost SET unit_cost=unit_cost+0.0001 WHERE plan_id='001'",
      /^pricing /,
    ],
    [
      "days supply",
      "UPDATE partd_plan_unit_cost SET days_supply=60 WHERE plan_id='001' AND days_supply=30",
      /^price_sample /,
    ],
    [
      "pricing membership",
      "DELETE FROM partd_plan_unit_cost WHERE plan_id='001'",
      /^pricing /,
    ],
  ])(
    "catches a planted %s error in the disposable database",
    async (_name, sql, pattern) => {
      const state = await loaded();
      try {
        await state.db.exec(sql);
        const problems = compareLarge(state.expected, await state.read());
        expect(
          problems.some((p) => pattern.test(p)),
          problems.join(", "),
        ).toBe(true);
      } finally {
        await state.close();
      }
    },
    180_000,
  );

  it("sizes each nested file without retaining its rows", async () => {
    const path = join(directory, "inventory.zip");
    await writeFile(path, syntheticArchive());
    const result = spawnSync("python3", ["-I", script, path, "--inventory"], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const reading = JSON.parse(result.stdout) as {
      files: { file: string; rows: number; text_bytes: number }[];
    };
    const networks = reading.files.filter((f) =>
      f.file.startsWith("pharmacy networks"),
    );
    expect(networks.map((f) => f.rows)).toEqual([1, 4]);
    expect(reading.files.find((f) => f.file.startsWith("pricing"))?.rows).toBe(
      4,
    );
    expect(reading.files.every((f) => f.text_bytes > 0)).toBe(true);
  });

  it("counts duplicates in its order-independent digest", () => {
    const a = rowAccumulator(),
      b = rowAccumulator(),
      c = rowAccumulator();
    ["a", "b", "a"].forEach((line) => a.add(line));
    ["b", "a", "a"].forEach((line) => b.add(line));
    ["a", "b"].forEach((line) => c.add(line));
    expect(a.result()).toEqual(b.result());
    expect(a.result()).not.toEqual(c.result());
  });
});

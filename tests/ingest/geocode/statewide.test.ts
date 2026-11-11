import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { setup } from "./helpers.js";
import {
  stageStatewide,
  geocodeStatewide,
  createRun,
  stagePage,
  refreshStatewideFallbacks,
  publishStatewide,
} from "../../../src/ingest/geocode/statewide.js";
import {
  checkCountyPoint,
  parseCounties,
} from "../../../src/ingest/geocode/counties.js";
import type { County } from "../../../src/ingest/geocode/counties.js";
import { readRecords } from "../../../src/ingest/csv/index.js";
import { statewideReport } from "../../../src/ingest/geocode/statewide-report.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixture,
  scope,
  setup as providerSetup,
} from "../qhp/provider-helpers.js";
import { importProviders } from "../../../src/ingest/qhp/provider.js";
import { parseBatch } from "../../../src/ingest/geocode/parse.js";

async function harness() {
  const h = await setup(),
    cut = JSON.parse(
      await readFile(
        new URL(
          "../../fixtures/geocode/tx-county-bounds.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { counties: County[] };
  // Synthetic rectangular rings for tests only; the enclosing bounds are an exact, regenerable Census cut.
  // Production uses the complete Census county polygons, never these rectangles.
  const counties = cut.counties.map((c) => ({
    ...c,
    rings: [
      [
        [c.west, c.south],
        [c.east, c.south],
        [c.east, c.north],
        [c.west, c.north],
        [c.west, c.south],
      ],
    ],
  }));
  for (const c of counties)
    await h.db.query(
      "INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)",
      [JSON.stringify(c)],
    );
  const responses = (
    await readFile(
      new URL("../../fixtures/geocode/tx-census.csv", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const inputs = JSON.parse(
    await readFile(
      new URL("../../fixtures/geocode/inputs.json", import.meta.url),
      "utf8",
    ),
  ) as { line_1: string }[];
  const requests: string[] = [];
  const acquire = async (csv: string) => {
    requests.push(csv);
    const lines = [];
    for await (const r of readRecords(
      (async function* () {
        yield csv;
      })(),
    )) {
      const index = inputs.findIndex((a) => a.line_1 === r.fields[1]);
      if (index < 0) throw new Error("Unknown fixture input");
      lines.push(responses[index]!.replace(/^"\d+"/, `"${r.fields[0]}"`));
    }
    return { file: await h.file(lines.join("\n") + "\n"), requests: 1 };
  };
  return { ...h, counties, acquire, requests };
}
describe("statewide TX queue", () => {
  it("preserves the same recorded Census coordinates and statuses in location and geography response formats", async () => {
    const locations = await parseBatch(
      await readFile(
        new URL("../../fixtures/geocode/census.csv", import.meta.url),
        "utf8",
      ),
    );
    const geographies = await parseBatch(
      await readFile(
        new URL("../../fixtures/geocode/tx-census.csv", import.meta.url),
        "utf8",
      ),
    );
    expect(locations.issues).toEqual([]);
    expect(geographies.issues).toEqual([]);
    for (const [id, row] of locations.rows) {
      const {
        countyFips,
        rawResponse: geographyRaw,
        ...location
      } = geographies.rows.get(id)!;
      const { rawResponse: locationRaw, ...expected } = row;
      expect(location).toEqual(expected);
      if (row.status === "Match") {
        expect(geographyRaw).toBeTruthy();
        expect(locationRaw).toBeTruthy();
      }
      if (row.status === "Match") expect(countyFips).toMatch(/^48\d{3}$/);
    }
  });
  it("requires loaded TX geography and can add newly available fallback evidence without resubmitting Census work", async () => {
    const h = await harness();
    try {
      const centroid = (
        await h.db.query(
          "DELETE FROM zcta_centroid WHERE zcta='77356' RETURNING *",
        )
      ).rows[0]!;
      await stageStatewide(h.db, { runId: "new-centroid" });
      await geocodeStatewide(h.db, h.counties, {
        runId: "new-centroid",
        acquire: h.acquire,
      });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM address_point")).rows[0]!
          .n,
      ).toBe(3);
      await h.db.query(
        "INSERT INTO zcta_centroid SELECT * FROM json_populate_record(NULL::zcta_centroid,$1::json)",
        [JSON.stringify(centroid)],
      );
      expect(
        await refreshStatewideFallbacks(h.db, h.counties, "new-centroid"),
      ).toBe(1);
      expect(
        await refreshStatewideFallbacks(h.db, h.counties, "new-centroid"),
      ).toBe(0);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM address_point")).rows[0]!
          .n,
      ).toBe(4);
      expect(
        (
          await h.db.query(
            "SELECT match_status,method FROM address_point WHERE source_row='1000000005:practice:0'",
          )
        ).rows,
      ).toEqual([{ match_status: "No_Match", method: "zcta_centroid" }]);
      expect(h.requests).toHaveLength(1);
      const before = (
        await h.db.query(
          "SELECT snapshot_id,geocoded_at FROM address_point ORDER BY source_row",
        )
      ).rows;
      await h.db.exec("UPDATE npi_address SET snapshot_id='new-input'");
      await stageStatewide(h.db, { runId: "source-refresh" });
      await publishStatewide(h.db, "source-refresh");
      expect(
        (
          await geocodeStatewide(h.db, h.counties, {
            runId: "source-refresh",
            acquire: h.acquire,
          })
        ).batches,
      ).toBe(0);
      expect(h.requests).toHaveLength(1);
      expect(
        (
          await h.db.query(
            "SELECT DISTINCT source_snapshot_id FROM address_point",
          )
        ).rows,
      ).toEqual([{ source_snapshot_id: "new-input" }]);
      expect(
        (
          await h.db.query(
            "SELECT snapshot_id,geocoded_at FROM address_point ORDER BY source_row",
          )
        ).rows,
      ).toEqual(before);
      await h.db.exec("DELETE FROM geo_import");
      await expect(
        geocodeStatewide(h.db, h.counties, {
          runId: "new-centroid",
          acquire: h.acquire,
        }),
      ).rejects.toThrow("TX geography import required");
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
  it("captures ACTIVE issuer shards, normalizes ZIP+4 and includes null-NPI addresses independently of plan edges", async () => {
    const h = await providerSetup();
    try {
      const provider = structuredClone((await fixture("records"))[0]);
      // Synthetic provider identity, public building address, duplicate row and one out-of-state location.
      provider.npi = null;
      provider.addresses = [
        {
          address: "901 Bagby St",
          city: "Houston",
          state: "TX",
          zip: "77002-1234",
        },
        { address: "901 Bagby St", city: "Houston", state: "TX", zip: "77002" },
        {
          address: "Synthetic non-TX location",
          city: "Columbus",
          state: "OH",
          zip: "43215",
        },
      ];
      await h.replace([provider]);
      await importProviders(h.db, scope);
      // Synthetic source-set state change: address state, not the network's state, defines TX location scope.
      await h.db.exec(
        "UPDATE provider_active_set SET state='OH'; UPDATE provider_source_set SET state='OH'",
      );
      await createRun(h.db, "frozen");
      const shards = (
        await h.db.query<{ source_shards: string[] }>(
          "SELECT source_shards FROM geocode_tx_run",
        )
      ).rows[0]!.source_shards;
      expect(shards).toHaveLength(1);
      await h.db.exec(
        "UPDATE provider_active_set SET state='TX'; UPDATE provider_source_set SET state='TX'",
      );
      // Later ACTIVE source sets must not change a resumed run's frozen input selection.
      provider.addresses = [
        {
          address: "6621 Fannin St",
          city: "Houston",
          state: "TX",
          zip: "77030",
        },
      ];
      await h.replace([provider]);
      await importProviders(h.db, scope);
      await stageStatewide(h.db, { runId: "frozen" });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_input"))
          .rows[0]!.n,
      ).toBe(2);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_address"))
          .rows[0]!.n,
      ).toBe(1);
      expect(
        (
          await h.db.query(
            "SELECT DISTINCT source_snapshot_id FROM geocode_tx_input",
          )
        ).rows,
      ).toEqual([{ source_snapshot_id: shards[0] }]);
      expect(
        (
          await h.db.query<{ address: { zip5: string; npi: null } }>(
            "SELECT address FROM geocode_tx_address",
          )
        ).rows[0]!.address,
      ).toMatchObject({ zip5: "77002", npi: null });
      await stageStatewide(h.db, { runId: "new-sources" });
      expect(
        (
          await h.db.query(
            "SELECT count(*)::int n FROM geocode_tx_input WHERE run_id='new-sources'",
          )
        ).rows[0]!.n,
      ).toBe(1);
    } finally {
      await h.close();
    }
  });
  it("deduplicates globally, retains unmatched/no-ZCTA evidence, and resumes staged inputs and completed batches", async () => {
    const h = await harness(),
      dir = await mkdtemp(join(tmpdir(), "tx-report-"));
    try {
      // Synthetic duplicate source identity, recorded public address: one Census row and two source attributions.
      await h.db
        .exec(`INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id) VALUES('1000000006',true,'TX','2026-11-07','input');
        INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id) VALUES('1000000006','practice',0,'901 Bagby St','Houston','TX','77002','input');
        INSERT INTO zcta_county VALUES('77002','48201','Harris County',1,0,1,0,1,0,'relationship',2)`);
      await createRun(h.db, "resume");
      expect(await stagePage(h.db, "resume", "npi_address", 2)).toBe(2);
      // Resume an interrupted staging pass. Persisted cursor and source keys prevent duplicates/loss.
      await stageStatewide(h.db, { runId: "resume" });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_input"))
          .rows[0]!.n,
      ).toBe(7);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_address"))
          .rows[0]!.n,
      ).toBe(6);
      const first = await geocodeStatewide(h.db, h.counties, {
        runId: "resume",
        batchSize: 2,
        maxBatches: 1,
        acquire: h.acquire,
      });
      expect(first).toMatchObject({ batches: 1, addressesSent: 2 });
      expect(
        await geocodeStatewide(h.db, h.counties, {
          runId: "resume",
          batchSize: 2,
          acquire: h.acquire,
          sleep: async () => {},
        }),
      ).toMatchObject({ batches: 2, addressesSent: 4 });
      expect(
        await geocodeStatewide(h.db, h.counties, {
          runId: "resume",
          acquire: async () => {
            throw new Error("Network forbidden");
          },
        }),
      ).toMatchObject({ batches: 0, addressesSent: 0 });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_attempt"))
          .rows[0]!.n,
      ).toBe(7);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM address_point")).rows[0]!
          .n,
      ).toBe(5);
      const report = await statewideReport(h.db, "resume", dir, h.counties);
      expect(report.totals).toMatchObject({
        addresses: 6,
        matched: 3,
        tie: 1,
        no_match: 2,
        fallback: 1,
        no_point: 2,
        pending: 0,
        bounds_errors: 0,
      });
      expect(report.publication).toMatchObject({
        completed_source_rows: 7,
        published_points: 5,
        errors: 0,
      });
      expect(report.negative_controls).toEqual({
        ohio_point_rejected: true,
        zero_point_rejected: true,
      });
      expect(h.requests).toHaveLength(3);
      // A corrupted API label must not turn an approximate ZIP fallback into a claimed match.
      await h.db.exec(
        "UPDATE address_point SET match_status='Match' WHERE method='zcta_centroid'",
      );
      expect(
        (await statewideReport(h.db, "resume", dir, h.counties)).publication
          ?.errors,
      ).toBe(1);
      await h.db.exec(
        "UPDATE address_point SET match_status='No_Match' WHERE method='zcta_centroid'",
      );
      // Independent oracle catches corruption of the actual API table, even if the result ledger is intact.
      await h.db.exec(
        `UPDATE address_point SET latitude=39.96,longitude=-82.99 WHERE source_row='1000000000:practice:0'`,
      );
      expect(
        (await statewideReport(h.db, "resume", dir, h.counties)).publication
          ?.errors,
      ).toBe(1);
    } finally {
      await h.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("negative control: interruption after writes rolls back every result and retains the exact pending batch", async () => {
    const h = await harness();
    try {
      await stageStatewide(h.db, { runId: "crash" });
      await expect(
        geocodeStatewide(h.db, h.counties, {
          runId: "crash",
          batchSize: 2,
          acquire: h.acquire,
          beforeCommit: async () => {
            throw new Error("Synthetic power loss");
          },
        }),
      ).rejects.toThrow("Synthetic power loss");
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_result"))
          .rows[0]!.n,
      ).toBe(0);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_attempt"))
          .rows[0]!.n,
      ).toBe(0);
      expect(
        (await h.db.query("SELECT completed FROM geocode_tx_batch")).rows,
      ).toEqual([{ completed: false }]);
      await expect(
        stageStatewide(h.db, { runId: "crash", geographies: true }),
      ).rejects.toThrow("Census request profile differs");
      await geocodeStatewide(h.db, h.counties, {
        runId: "crash",
        batchSize: 2,
        maxBatches: 1,
        acquire: h.acquire,
      });
      expect(h.requests[1]).toBe(h.requests[0]);
      await geocodeStatewide(h.db, h.counties, {
        runId: "crash",
        batchSize: 2,
        acquire: h.acquire,
        sleep: async () => {},
      });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_attempt"))
          .rows[0]!.n,
      ).toBe(6);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_result"))
          .rows[0]!.n,
      ).toBe(6);
      expect(
        (
          await h.db.query(
            "SELECT count(*)::int n FROM geocode_tx_batch WHERE completed",
          )
        ).rows[0]!.n,
      ).toBe(3);
    } finally {
      await h.cleanup();
    }
  });
  it("rejects only the Ohio row, retains raw evidence, publishes its labelled fallback and catches a published-point mutant", async () => {
    const h = await harness(),
      dir = await mkdtemp(join(tmpdir(), "tx-rejection-"));
    try {
      await stageStatewide(h.db, { runId: "ohio" });
      await expect(
        geocodeStatewide(h.db, h.counties, {
          runId: "ohio",
          acquire: async (csv) => {
            const good = await h.acquire(csv),
              text = await readFile(good.file.path, "utf8");
            return {
              file: await h.file(
                text
                  .replace("-95.369483289562,29.760724420884", "-82.99,39.96")
                  .replace(
                    "901 BAGBY ST, HOUSTON, TX, 77002",
                    "SYNTHETIC OHIO MATCH, COLUMBUS, OH, 43215",
                  ),
              ),
              requests: 1,
            };
          },
        }),
      ).resolves.toMatchObject({ batches: 1, addressesSent: 6 });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_result"))
          .rows[0]!.n,
      ).toBe(6);
      expect(
        (await h.db.query("SELECT completed FROM geocode_tx_batch")).rows,
      ).toEqual([{ completed: true }]);
      const rejected = (
        await h.db.query(
          "SELECT * FROM geocode_tx_result WHERE match_status='rejected_out_of_bounds'",
        )
      ).rows;
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        method: "zcta_centroid",
        match_quality: null,
        centroid_snapshot_id: "centroid",
        county_fips: "48201",
        rejection: {
          returned_state: "OH",
          latitude: 39.96,
          longitude: -82.99,
          match_quality: "Exact",
          reason: "state_mismatch",
        },
      });
      expect(
        (rejected[0]!.rejection as { raw_response: string }).raw_response,
      ).toContain("-82.99,39.96");
      expect(
        (
          await h.db.query(
            "SELECT raw_path FROM snapshot WHERE snapshot_id=$1",
            [rejected[0]!.snapshot_id],
          )
        ).rows[0]!.raw_path,
      ).toBeTruthy();
      expect(
        (
          await h.db.query(
            "SELECT method,match_status,match_quality FROM address_point WHERE source_row='1000000000:practice:0'",
          )
        ).rows,
      ).toEqual([
        {
          method: "zcta_centroid",
          match_status: "rejected_out_of_bounds",
          match_quality: null,
        },
      ]);
      const report = await statewideReport(h.db, "ohio", dir, h.counties);
      expect(report.totals).toMatchObject({
        addresses: 6,
        matched: 2,
        tie: 1,
        no_match: 2,
        rejected: 1,
        fallback: 2,
        pending: 0,
        bounds_errors: 0,
      });
      expect(report.publication?.errors).toBe(0);
      expect(report.rejected_rows).toHaveLength(1);
      await geocodeStatewide(h.db, h.counties, {
        runId: "ohio",
        acquire: async () => {
          throw new Error("Network forbidden");
        },
      });
      // Bypass the writer deliberately: the actual API point audit must catch publication of rejected Ohio coordinates.
      await h.db.exec(
        "UPDATE address_point SET latitude=39.96,longitude=-82.99 WHERE source_row='1000000000:practice:0'",
      );
      expect(
        (await statewideReport(h.db, "ohio", dir, h.counties)).publication
          ?.errors,
      ).toBe(1);
      expect(() =>
        checkCountyPoint(39.96, -82.99, "48201", h.counties),
      ).toThrow("County bounds");
      expect(() => checkCountyPoint(0, 0, "48201", h.counties)).toThrow(
        "County bounds",
      );
    } finally {
      await h.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(["locations", "wrong-county", "wrong-state"] as const)(
    "rejects a %s mismatch without discarding valid siblings",
    async (kind) => {
      const h = await harness();
      try {
        const geographies = kind !== "locations";
        await stageStatewide(h.db, { runId: kind, geographies });
        await geocodeStatewide(h.db, h.counties, {
          runId: kind,
          geographies,
          acquire: async (csv) => {
            const good = await h.acquire(csv);
            let text = await readFile(good.file.path, "utf8");
            if (kind === "locations")
              text = text
                .replace(/,"48","\d{3}","\d{6}","\d{4}"/g, "")
                .replace("-95.369483289562,29.760724420884", "-82.99,39.96");
            else if (kind === "wrong-county")
              text = text.replace(
                /,"48","201","980700","1080"/,
                ',"48","113","980700","1080"',
              );
            else
              text = text.replace(
                "901 BAGBY ST, HOUSTON, TX, 77002",
                "SYNTHETIC STATE MISMATCH, HOUSTON, OH, 77002",
              );
            return { file: await h.file(text), requests: 1 };
          },
        });
        expect(
          (
            await h.db.query(
              "SELECT count(*)::int n FROM geocode_tx_result WHERE match_status='rejected_out_of_bounds'",
            )
          ).rows[0]!.n,
        ).toBe(1);
        expect(
          (
            await h.db.query(
              "SELECT count(*)::int n FROM geocode_tx_result WHERE match_status='Match'",
            )
          ).rows[0]!.n,
        ).toBe(2);
        expect(
          (await h.db.query("SELECT count(*)::int n FROM address_point"))
            .rows[0]!.n,
        ).toBe(4);
      } finally {
        await h.cleanup();
      }
    },
  );
  it("attaches a newly available verified fallback to a rejected no-point observation without resubmission", async () => {
    const h = await harness();
    try {
      const centroid = (
        await h.db.query(
          "DELETE FROM zcta_centroid WHERE zcta='77002' RETURNING *",
        )
      ).rows[0]!;
      await stageStatewide(h.db, { runId: "rejected-no-centroid" });
      await geocodeStatewide(h.db, h.counties, {
        runId: "rejected-no-centroid",
        acquire: async (csv) => {
          const good = await h.acquire(csv),
            text = await readFile(good.file.path, "utf8");
          return {
            file: await h.file(
              text.replace("-95.369483289562,29.760724420884", "-82.99,39.96"),
            ),
            requests: 1,
          };
        },
      });
      const before = (
        await h.db.query(
          "SELECT * FROM geocode_tx_result WHERE match_status='rejected_out_of_bounds'",
        )
      ).rows[0]!;
      expect(before).toMatchObject({
        method: null,
        latitude: null,
        longitude: null,
        centroid_snapshot_id: null,
      });
      expect(
        (
          await h.db.query(
            "SELECT match_status,outcome FROM geocode_attempt WHERE source_row='1000000000:practice:0'",
          )
        ).rows,
      ).toEqual([
        { match_status: "rejected_out_of_bounds", outcome: "no_point" },
      ]);
      await h.db.query(
        "INSERT INTO zcta_centroid SELECT * FROM json_populate_record(NULL::zcta_centroid,$1::json)",
        [JSON.stringify(centroid)],
      );
      expect(
        await refreshStatewideFallbacks(
          h.db,
          h.counties,
          "rejected-no-centroid",
        ),
      ).toBe(1);
      expect(
        await refreshStatewideFallbacks(
          h.db,
          h.counties,
          "rejected-no-centroid",
        ),
      ).toBe(0);
      expect(
        (
          await h.db.query(
            "SELECT snapshot_id,geocoded_at,rejection,method FROM geocode_tx_result WHERE match_status='rejected_out_of_bounds'",
          )
        ).rows[0],
      ).toEqual({
        snapshot_id: before.snapshot_id,
        geocoded_at: before.geocoded_at,
        rejection: before.rejection,
        method: "zcta_centroid",
      });
      expect(h.requests).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
  it("keeps a missing geography claim pending rather than treating missing evidence as a bounds rejection", async () => {
    const h = await harness();
    try {
      await stageStatewide(h.db, { runId: "missing-claim", geographies: true });
      await expect(
        geocodeStatewide(h.db, h.counties, {
          runId: "missing-claim",
          geographies: true,
          acquire: async (csv) => {
            const good = await h.acquire(csv),
              text = (await readFile(good.file.path, "utf8")).replace(
                /,"48","201","980700","1080"/,
                "",
              );
            return { file: await h.file(text), requests: 1 };
          },
        }),
      ).rejects.toThrow("Incomplete Census county claim");
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_result"))
          .rows[0]!.n,
      ).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
  it("negative control: truncated, duplicate and unexpected Census rows leave the batch pending", async () => {
    const h = await harness();
    try {
      await stageStatewide(h.db, { runId: "malformed" });
      for (const mutate of [
        (s: string) => s.split("\n").slice(1).join("\n"),
        (s: string) => s + s.split("\n")[0] + "\n",
        (s: string) => s + '"999","synthetic","No_Match"\n',
      ]) {
        await expect(
          geocodeStatewide(h.db, h.counties, {
            runId: "malformed",
            acquire: async (csv) => {
              const good = await h.acquire(csv);
              return {
                file: await h.file(
                  mutate(await readFile(good.file.path, "utf8")),
                ),
                requests: 1,
              };
            },
          }),
        ).rejects.toThrow("Incomplete Census batch");
      }
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_tx_result"))
          .rows[0]!.n,
      ).toBe(0);
      await expect(
        geocodeStatewide(h.db, h.counties, {
          runId: "malformed",
          batchSize: 10001,
        }),
      ).rejects.toThrow("Batch size");
      expect(() => parseCounties('{"features":[]}', "synthetic")).toThrow(
        "Incomplete TX",
      );
    } finally {
      await h.cleanup();
    }
  });
  it("keeps batch publication indexed as other states enlarge the ledger", async () => {
    const h = await harness();
    try {
      const runId = "synthetic-lookup-plan";
      await stageStatewide(h.db, { runId });
      // Synthetic unrelated no-point observations make a whole-ledger scan expensive.
      await h.db
        .exec(`INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,county_basis,snapshot_id)
        SELECT lpad(to_hex(i),64,'0'),'synthetic unrelated address','No_Match','unknown','input'
        FROM generate_series(1,25000) i;
        ANALYZE geocode_tx_result; ANALYZE geocode_tx_input`);
      const hashes = (
        await h.db.query(
          "SELECT address_hash FROM geocode_tx_address WHERE run_id=$1",
          [runId],
        )
      ).rows.map((r) => String(r.address_hash));
      while (hashes.length < 2000)
        hashes.push(hashes.length.toString(16).padStart(64, "0"));
      const statements: { sql: string; parameters?: unknown[] }[] = [];
      await publishStatewide(
        {
          query: async (sql, parameters) => {
            statements.push({ sql, parameters });
            return { rows: [] };
          },
          exec: async () => {},
        },
        runId,
        hashes,
      );
      interface Plan {
        "Node Type": string;
        "Relation Name"?: string;
        "Index Cond"?: string;
        Plans?: Plan[];
      }
      function scans(plan: Plan): Plan[] {
        return [
          ...(plan["Relation Name"] === "geocode_tx_result" ? [plan] : []),
          ...(plan.Plans ?? []).flatMap(scans),
        ];
      }
      for (const statement of statements) {
        const plan = (
          await h.db.query(
            "EXPLAIN (FORMAT JSON) " + statement.sql,
            statement.parameters,
          )
        ).rows[0]!["QUERY PLAN"] as { Plan: Plan }[];
        const indexed = scans(plan[0]!.Plan);
        expect(indexed.length).toBeGreaterThan(0);
        expect(
          indexed.every(
            (p) =>
              p["Node Type"] === "Index Scan" &&
              p["Index Cond"]?.includes("address_hash"),
          ),
        ).toBe(true);
        // Mutate a disposable statement, never the source: the old join scans unrelated results.
        const mutant = statement.sql.replace(
          /JOIN LATERAL \(SELECT \* FROM geocode_tx_result r\s+WHERE r.address_hash=i.address_hash OFFSET 0\) r ON true/,
          "JOIN geocode_tx_result r USING(address_hash)",
        );
        expect(mutant).not.toBe(statement.sql);
        const bad = (
          await h.db.query(
            "EXPLAIN (FORMAT JSON) " + mutant,
            statement.parameters,
          )
        ).rows[0]!["QUERY PLAN"] as { Plan: Plan }[];
        expect(
          scans(bad[0]!.Plan).some(
            (p) => p["Node Type"] === "Seq Scan" || !p["Index Cond"],
          ),
        ).toBe(true);
      }
    } finally {
      await h.cleanup();
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers.js";
import { createApp } from "../../../src/api/app.js";
import { saveResult } from "../../../src/ingest/geocode/repository.js";
import {
  stageStatewide,
  geocodeStatewide,
  createRun,
  publishStatewide,
} from "../../../src/ingest/geocode/statewide.js";
import * as countySources from "../../../src/ingest/geocode/counties.js";
import {
  countyQuery,
  parseCounties,
  geocodeStates,
} from "../../../src/ingest/geocode/counties.js";
import type { County } from "../../../src/ingest/geocode/counties.js";
import { statewideReport } from "../../../src/ingest/geocode/statewide-report.js";
import { readRecords } from "../../../src/ingest/csv/index.js";
import {
  bootstrapPlan,
  parseBootstrapOptions,
} from "../../../src/worker/bootstrap.js";
import { createDatabase } from "../../../src/db/database.js";
import type { Database, SqlSession } from "../../../src/db/database.js";

// Entirely synthetic inputs, county rectangles, coordinates and Census responses.
// These test state isolation and rejection mechanics, never published provider facts.
const scopes = {
  FL: {
    county: "12086",
    city: "Synthetic FL city",
    zip: "33130",
    lat: 25.77,
    lon: -80.19,
  },
  NC: {
    county: "37119",
    city: "Synthetic NC city",
    zip: "28202",
    lat: 35.22,
    lon: -80.84,
  },
};
describe("FL and NC statewide geocoding", () => {
  it.each(["FL", "NC"] as const)(
    "%s stages only its address state, rejects TX and labels independent fallbacks",
    async (state) => {
      let database: Database | undefined;
      if (process.env.GEOCODE_MULTISTATE_POSTGIS_URL) {
        const url = new URL(process.env.GEOCODE_MULTISTATE_POSTGIS_URL);
        if (url.pathname !== "/openplans_p3l_controls")
          throw new Error(
            "Multistate PostGIS controls require their disposable database prefix",
          );
        url.pathname += `_${state.toLowerCase()}`;
        database = createDatabase(url.href);
      }
      const h = await setup(database),
        root = await mkdtemp(join(tmpdir(), "multistate-geocode-"));
      const scope = scopes[state],
        county: County = {
          county_fips: scope.county,
          name: "Synthetic rectangle",
          south: scope.lat - 0.2,
          north: scope.lat + 0.2,
          west: scope.lon - 0.2,
          east: scope.lon + 0.2,
          rings: [
            [
              [scope.lon - 0.2, scope.lat - 0.2],
              [scope.lon + 0.2, scope.lat - 0.2],
              [scope.lon + 0.2, scope.lat + 0.2],
              [scope.lon - 0.2, scope.lat + 0.2],
              [scope.lon - 0.2, scope.lat - 0.2],
            ],
          ],
          snapshot_id: "centroid",
        };
      try {
        await expect(
          statewideReport(h.db, "missing-run", root, [county]),
        ).rejects.toThrow("Missing statewide run");
        await h.db.query(
          `INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
        VALUES($1,2026,'relationship','centroid','rating')`,
          [state],
        );
        await h.db.query(
          "INSERT INTO zcta_centroid VALUES($1,$2,$3,'centroid',2)",
          [scope.zip, scope.lat, scope.lon],
        );
        await h.db.query(
          "INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)",
          [JSON.stringify(county)],
        );
        for (let i = 0; i < 5; i++) {
          const npi = `100000001${i}`;
          await h.db.query(
            "INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id) VALUES($1,true,$2,'2026-11-08','input')",
            [npi, state],
          );
          await h.db.query(
            `INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
          VALUES($1,'practice',0,$2,$3,$4,$5,'input')`,
            [
              npi,
              `${i} SYNTHETIC TEST`,
              scope.city,
              state,
              i === 4 ? "77002" : scope.zip,
            ],
          );
        }
        // A source identity can have practice addresses in several states. Selection follows address state.
        await h.db
          .query(`INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
        VALUES('1000000010','practice',1,'Synthetic TX location','Houston','TX','77002','input')`);
        const options = { runId: `test-${state}`, state };
        await stageStatewide(h.db, options);
        expect(
          (
            await h.db.query(
              "SELECT DISTINCT address->>'state' state FROM geocode_tx_address",
            )
          ).rows,
        ).toEqual([{ state }]);
        expect(
          (await h.db.query("SELECT count(*)::int n FROM geocode_tx_input"))
            .rows[0]!.n,
        ).toBe(5);
        await expect(
          createRun(h.db, options.runId, false, state === "FL" ? "NC" : "FL"),
        ).rejects.toThrow("state differs");
        let calls = 0;
        const acquire = async (csv: string) => {
          calls++;
          const lines = [];
          for await (const record of readRecords(
            (async function* () {
              yield csv;
            })(),
          )) {
            const id = record.fields[0],
              index = Number(record.fields[1]!.split(" ")[0]);
            function censusResultRow() {
              if (index === 0) {
                return `"${id}","synthetic","Match","Exact","0 SYNTHETIC TEST, ${scope.city}, ${state}, ${scope.zip}","${scope.lon},${scope.lat}","1","L"`;
              } else if (index === 1) {
                return `"${id}","synthetic","Match","Exact","1 SYNTHETIC TEST, HOUSTON, TX, 77002","-95.37,29.76","1","L"`;
              } else {
                return `"${id}","synthetic","${index === 2 ? "Tie" : "No_Match"}"`;
              }
            }
            lines.push(censusResultRow());
          }
          return { file: await h.file(lines.join("\n") + "\n"), requests: 1 };
        };
        await geocodeStatewide(h.db, [county], { ...options, acquire });
        const report = await statewideReport(h.db, options.runId, root, [
          county,
        ]);
        expect(report.totals).toMatchObject({
          addresses: 5,
          resolved: 5,
          matched: 1,
          tie: 1,
          no_match: 2,
          rejected: 1,
          fallback: 3,
          no_point: 1,
          pending: 0,
          bounds_errors: 0,
        });
        expect(report.publication).toMatchObject({
          completed_source_rows: 5,
          published_points: 4,
          errors: 0,
        });
        expect(
          (
            await h.db.query(
              "SELECT match_status,method,match_quality,centroid_snapshot_id FROM address_point WHERE source_row='1000000011:practice:0'",
            )
          ).rows,
        ).toEqual([
          {
            match_status: "rejected_out_of_bounds",
            method: "zcta_centroid",
            match_quality: null,
            centroid_snapshot_id: "centroid",
          },
        ]);
        const hash = String(
          (
            await h.db.query(
              "SELECT address_hash FROM geocode_tx_result WHERE method IS NOT NULL LIMIT 1",
            )
          ).rows[0]!.address_hash,
        );
        await h.db.query("DELETE FROM address_point WHERE address_hash=$1", [
          hash,
        ]);
        await h.db.query("DELETE FROM geocode_attempt WHERE address_hash=$1", [
          hash,
        ]);
        expect(
          (await statewideReport(h.db, options.runId, root, [county]))
            .publication?.errors,
        ).toBe(1);
        await publishStatewide(h.db, options.runId, [hash, hash]);
        expect(
          (await statewideReport(h.db, options.runId, root, [county]))
            .publication?.errors,
        ).toBe(0);
        // A local address carrying a TX ZIP must never receive its out-of-state centroid.
        expect(
          (
            await h.db.query(
              "SELECT outcome FROM geocode_attempt WHERE source_row='1000000014:practice:0'",
            )
          ).rows,
        ).toEqual([{ outcome: "no_point" }]);
        if (database) {
          const cached = vi
            .spyOn(countySources, "acquireCounties")
            .mockResolvedValue([county]);
          try {
            const plan = await bootstrapPlan(
              parseBootstrapOptions([
                "--states",
                state,
                "--years",
                "2026",
                "--with-geocode",
              ]),
              () => h.db,
              root,
            );
            const result = await plan
              .find((step) => step.id === `geocode-${state}`)!
              .run();
            expect(result).toMatchObject({
              evidence: { batches: 0, requests: 0 },
            });
            const before = (
              await h.db.query("SELECT count(*)::int n FROM geocode_tx_run")
            ).rows[0]!.n;
            expect(
              await plan.find((step) => step.id === `geocode-${state}`)!.run(),
            ).toMatchObject({
              skipped: true,
              reason: "all_selected_addresses_have_terminal_attempts",
            });
            expect(
              (await h.db.query("SELECT count(*)::int n FROM geocode_tx_run"))
                .rows[0]!.n,
            ).toBe(before);
            // Synthetic new immutable import pointer invalidates the completed bootstrap scope.
            await h.db.query(
              "INSERT INTO npi_import_run(snapshot_id,kind,state_filter,data_date,report) VALUES('new-input','weekly',$1,'2026-11-08','{}')",
              [state],
            );
            expect(
              await plan.find((step) => step.id === `geocode-${state}`)!.run(),
            ).toMatchObject({ evidence: { batches: 0, requests: 0 } });
            expect(
              (await h.db.query("SELECT count(*)::int n FROM geocode_tx_run"))
                .rows[0]!.n,
            ).toBe(Number(before) + 1);
          } finally {
            cached.mockRestore();
          }
        }
        await saveResult(
          h.db,
          h.addresses[0]!,
          {
            id: "synthetic-tx",
            status: "Match",
            quality: "Exact",
            latitude: 29.76,
            longitude: -95.37,
          },
          "input",
        );
        const app = createApp(h.db),
          path = `/v1/providers?lat=${scope.lat}&lon=${scope.lon}&radius_miles=10`;
        const response = await app.request(path),
          body = (await response.json()) as {
            providers: { npi: string }[];
            total: number;
          };
        expect(response.status).toBe(200);
        expect(body.total).toBe(4);
        expect(body.providers.some((p) => p.npi === h.addresses[0]!.npi)).toBe(
          false,
        );
        // Deliberately relocate the TX publication into this query: the isolation assertion detects it.
        await h.db.query(
          "UPDATE address_point SET latitude=$1,longitude=$2 WHERE source_row='1000000000:practice:0'",
          [scope.lat, scope.lon],
        );
        const mutant = (await (await app.request(path)).json()) as typeof body;
        expect(() =>
          expect(
            mutant.providers.some((p) => p.npi === h.addresses[0]!.npi),
          ).toBe(false),
        ).toThrow();
        // Database bounds independently reject a TX coordinate attributed to this state's county.
        await expect(
          h.db.query(
            "UPDATE geocode_tx_result SET latitude=29.76,longitude=-95.37 WHERE match_status='Match'",
          ),
        ).rejects.toThrow();
        // A mutant of the actual publication table must fail the independent audit.
        await h.db.query(
          "UPDATE address_point SET latitude=29.76,longitude=-95.37 WHERE source_row='1000000010:practice:0'",
        );
        expect(
          (await statewideReport(h.db, options.runId, root, [county]))
            .publication?.errors,
        ).toBe(1);
        await publishStatewide(h.db, options.runId);
        // Mutate both ledgers consistently into a valid TX county: the frozen run-state audit must still fail.
        const txCounty = {
          ...county,
          county_fips: "48201",
          name: "Synthetic TX rectangle",
          south: 29.5,
          north: 30,
          west: -96,
          east: -95,
          rings: [
            [
              [-96, 29.5],
              [-95, 29.5],
              [-95, 30],
              [-96, 30],
              [-96, 29.5],
            ],
          ],
        };
        await h.db.query(
          "INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)",
          [JSON.stringify(txCounty)],
        );
        await h.db.query(
          "UPDATE geocode_tx_result SET latitude=29.76,longitude=-95.37,county_fips='48201' WHERE match_status='Match'",
        );
        await publishStatewide(h.db, options.runId);
        const wrongState = await statewideReport(h.db, options.runId, root, [
          county,
        ]);
        expect(wrongState.totals.bounds_errors).toBe(1);
        expect(wrongState.publication?.errors).toBe(1);
        await h.db.query(
          "UPDATE geocode_tx_result SET latitude=$1,longitude=$2,county_fips=$3 WHERE match_status='Match'",
          [scope.lat, scope.lon, scope.county],
        );
        await publishStatewide(h.db, options.runId);
        await stageStatewide(h.db, { ...options, runId: `reuse-${state}` });
        await publishStatewide(h.db, `reuse-${state}`);
        expect(
          await geocodeStatewide(h.db, [county], {
            ...options,
            runId: `reuse-${state}`,
            acquire: async () => {
              throw new Error("Network forbidden");
            },
          }),
        ).toMatchObject({ batches: 0, requests: 0 });
        expect(calls).toBe(1);
        await expect(
          geocodeStatewide(
            h.db,
            [{ ...county, county_fips: "48201" }],
            options,
          ),
        ).rejects.toThrow("County geometry state differs");
      } finally {
        await h.cleanup();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["FL", "NC"] as const)(
    "%s validates county count, FIPS, extent and separate cache query",
    (state) => {
      const s = scopes[state];
      const data = {
        spatialReference: { wkid: 4326 },
        features: [
          {
            attributes: { GEOID: s.county, NAME: "Synthetic" },
            geometry: {
              rings: [
                [
                  [s.lon - 0.1, s.lat - 0.1],
                  [s.lon + 0.1, s.lat - 0.1],
                  [s.lon + 0.1, s.lat + 0.1],
                  [s.lon - 0.1, s.lat - 0.1],
                ],
              ],
            },
          },
        ],
      };
      expect(
        parseCounties(JSON.stringify(data), "synthetic", 1, state),
      ).toHaveLength(1);
      expect(() =>
        parseCounties(
          JSON.stringify(data),
          "synthetic",
          geocodeStates[state].counties,
          state,
        ),
      ).toThrow("Incomplete");
      data.features[0]!.attributes.GEOID = "48201";
      expect(() =>
        parseCounties(JSON.stringify(data), "synthetic", 1, state),
      ).toThrow("Invalid");
      expect(countyQuery(state)).toContain(
        `STATE%3D%27${geocodeStates[state].fips}%27`,
      );
    },
  );
  it.each(["FL", "NC"] as const)(
    "bootstrap %s reaches the shared writer lock rather than rejecting the state",
    async (state) => {
      const db = {
        transaction: async (run: Parameters<Database["transaction"]>[0]) =>
          run({
            query: async () => ({ rows: [{ locked: false }] }),
            exec: async () => {},
          } as unknown as SqlSession),
      } as unknown as Database;
      const plan = await bootstrapPlan(
        parseBootstrapOptions([
          "--states",
          state,
          "--years",
          "2026",
          "--with-geocode",
        ]),
        () => db,
        "/tmp/synthetic-unused-cache",
      );
      await expect(
        plan.find((step) => step.id === `geocode-${state}`)!.run(),
      ).rejects.toThrow("another_statewide_geocoder_owns_lock");
    },
  );
});

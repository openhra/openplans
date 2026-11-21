import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryYears } from "@openplans/plugin-sdk";
import type { SqlSession } from "../../src/db/database.js";
import { publishAnnualData } from "../../src/db/data-window.js";

export const fixtureYears = [2024, 2025, 2026, 2027, 2028, 2029];
export const calendarPositions = [
  "2026-01-01T00:00:00.000Z",
  "2026-07-01T12:00:00.000Z",
  "2026-09-30T23:59:59.999Z",
  "2026-10-01T00:00:00.000Z",
  "2026-12-31T23:59:59.999Z",
  "2027-01-01T00:00:00.000Z",
  "2026-12-31T23:59:59-05:00",
  "2027-11-01T00:00:00.000Z",
];
export const annualDomains = ["individual", "medicare"] as const;
export const admissionStates = [
  "none",
  "individual",
  "medicare",
  "both",
] as const;
export type AdmissionState = (typeof admissionStates)[number];
export const syntheticPlan = "00000TX0000000";

export async function seedWindowFixture(db: SqlSession) {
  await db.exec(
    await readFile(
      new URL("../fixtures/data-window/synthetic.sql", import.meta.url),
      "utf8",
    ),
  );
}

/** Synthetic empty AK catalog admits next year while the real TX fixture remains missing that year. */
export async function admitSyntheticNextYear(
  db: SqlSession,
  directory?: string,
) {
  await db.exec(`
    INSERT INTO source(source_id,publisher,source_kind)
      VALUES('synthetic-next-admission','Synthetic empty catalog','synthetic');
    INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,fetched_children,sha256,retrieved_at,activated_at)
      VALUES('synthetic-next-2027','synthetic-next-admission','ACTIVE',0,0,repeat('a',64),'2026-01-01Z','2026-01-01Z');
    INSERT INTO puf_import(import_id,state,plan_year) VALUES('synthetic-next-2027','AK',2027);
    INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES('synthetic-next-2027','plan-attributes','synthetic-next-2027');
    INSERT INTO puf_active_catalog(state,plan_year,import_id) VALUES('AK',2027,'synthetic-next-2027');
  `);
  const payload =
    '{"synthetic":true,"state":"AK","plan_year":2027,"plans":[]}\n';
  const path = directory ? join(directory, "synthetic-next-2027.json") : null;
  if (path) await writeFile(path, payload);
  await db.query(
    "UPDATE snapshot SET sha256=$1,raw_path=$2 WHERE snapshot_id='synthetic-next-2027'",
    [createHash("sha256").update(payload).digest("hex"), path],
  );
  await publishAnnualData(db, [
    {
      domain: "individual",
      coverage_year: 2027,
      manifest: {
        schema_version: 1,
        releases: [
          {
            kind: "puf",
            snapshot_id: "synthetic-next-2027",
            contract_year: 2027,
          },
        ],
      },
    },
  ]);
}

export async function setWindowAdmissions(
  db: SqlSession,
  state: AdmissionState,
  calendarYear: number,
) {
  await db.exec("DELETE FROM annual_data_admission");
  for (const domain of annualDomains) {
    if (state !== "both" && state !== domain) continue;
    const year = calendarYear + 1;
    await db.query(
      "INSERT INTO annual_data_admission(domain,coverage_year,manifest) VALUES ($1,$2,$3)",
      [
        domain,
        year,
        {
          schema_version: 1,
          releases: [
            {
              kind: domain === "individual" ? "puf" : "medicare",
              snapshot_id: `synthetic-window-${year}`,
              contract_year: year,
            },
          ],
        },
      ],
    );
  }
}

// Independent table oracle, deliberately separate from the production resolver.
export function expectedWindow(
  history: HistoryYears,
  calendarYear: number,
  admitted: boolean,
) {
  const windows = {
    1: { waiting: [calendarYear], admitted: [calendarYear] },
    2: {
      waiting: [calendarYear - 1, calendarYear],
      admitted: [calendarYear, calendarYear + 1],
    },
    3: {
      waiting: [calendarYear - 1, calendarYear],
      admitted: [calendarYear - 1, calendarYear, calendarYear + 1],
    },
  };
  return windows[history][admitted ? "admitted" : "waiting"];
}

export function expectedDomains(
  history: HistoryYears,
  calendarYear: number,
  state: AdmissionState,
  missingPrevious = false,
) {
  return Object.fromEntries(
    annualDomains.map((domain) => {
      const admitted = state === "both" || state === domain;
      const loaded = fixtureYears.filter(
        (year) =>
          !(
            missingPrevious &&
            domain === "individual" &&
            year === calendarYear - 1
          ),
      );
      const allowed = expectedWindow(history, calendarYear, admitted);
      return [
        domain,
        {
          allowed_years: allowed,
          admitted_years: admitted ? [calendarYear + 1] : [],
          loaded_years: loaded,
          excluded_loaded_years: loaded.filter(
            (year) => !allowed.includes(year),
          ),
          missing_allowed_years: allowed.filter(
            (year) => !loaded.includes(year),
          ),
        },
      ];
    }),
  );
}
